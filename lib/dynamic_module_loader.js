/*
 * Copyright 2012-2013 Nuance Communications Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * dynamic_module
 *
 * @author Kevan Dunsmore
 * @created 2012/08/26
 */
var Future = require('futures').future;
var tar = require('tar');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var execFile = require('child_process').execFile;
var util = require('util');
var path = require('path');
var events = require('events');
var url = require('url');
var http = require('http');
var https = require('https');
var fs = require('fs-extra');
var rimraf = require('rimraf');

var eh = require('error-handling');
var LockManager = require('hurt-locker').LockManager;
var callbacks = require('callback-utils');
var _ = require('underscore');
var startsWith = require('underscore.string/startsWith');
var trim = require('underscore.string/trim');

var Class = require('jsclass/src/core').Class;

var logger;

var TAR_SUFFIX = ".tar";
var GZIP_SUFFIX = ".gz";
var TAR_GZIP_SUFFIX = TAR_SUFFIX + GZIP_SUFFIX;
var ZIP_SUFFIX = ".zip";

var config = require('./dml_config');

//TODO use ES6 classes
var DynamicModuleLoader = new Class(
    events.EventEmitter,
    {
        events:{
            moduleDownloaded:"moduleDownloaded",
            moduleExtracted:"moduleExtracted",
            moduleInstalled:"moduleInstalled",
            moduleLoaded:"moduleLoaded",
            moduleEvicted:"moduleEvicted",
            moduleDestroyed: "moduleDestroyed"
        },

        initialize:function (settings, applogger)
        {
            events.EventEmitter.call(this);

            if (applogger) {
              logger = applogger;
            }
            else {
              logger = require('winston').loggers.get('dynamic-module-loader');
            }

            if (settings instanceof Function)
            {
                settings = settings();
            }

            if (settings && !settings.lockManager)
            {
                settings.lockManager = new LockManager();
            }

            this.settings = config.createDefaultConfig();
            if (settings)
            {
                Object.assign(this.settings, settings);
            }

            if (!this.settings.lockManager)
            {
                this.settings.lockManager = new LockManager();
            }

            this.downloadedModuleMainFileCache = {};

            // OK, so this bit's quite cheeky.  The counted callback, used to allow event listeners to push the
            // download and install operation along, doesn't work if we have no listeners.  To save having to
            // check the listener count for every event and manually force the next stage if there are no listeners
            // to an event, we ensure that one listener is registered for each event.  It doesn't actually matter
            // what the listener does, just as long as it forces the loader to continue without error.  This has the
            // effect of nudging it along through its workflow until it succeeds at the end.  If we have an external
            // listener, and it signifies an error, we stop and error out the entire operation.
            this.on(this.events.moduleDownloaded, alwaysProceedWithoutError);
            this.on(this.events.moduleExtracted, alwaysProceedWithoutError);
            this.on(this.events.moduleInstalled, alwaysProceedWithoutError);
            this.on(this.events.moduleLoaded, alwaysProceedWithoutError);

            function alwaysProceedWithoutError()
            {
                for (var i = arguments.length - 1; i >= 0; i--)
                {
                    if (_.isFunction(arguments[i]))
                    {
                        // We've found our callback function.  Signify that there's no error.
                        arguments[i](undefined);
                        return;
                    }
                }
            }
        },

        /**
         * Load the requested module and cache it locally using moduleName as key. If downloadFullUrl is not provided
         * the function will try to find the module in the modulePackageServerUrl set in the settings by looking at a
         * file named {moduleName}.{remoteServerPackageFileExtension} on {modulePackageServerUrl}
         * @param moduleName {String} The name of the module to load, will be use as a key for caching this module.
         * @param remoteServerPackageFileExtension {String} The extension of the package, if undefined will be set to
         * {defaultRemoteServerPackageFileExtension}
         * @param downloadFullUrl {String} The full url where to get the module compressed from.
         * @param subDirectory If specified, will create a subdirectory in 'moduleInstallationDir' and will install
         *                     the module in it. It permits to regroup some modules
         * @returns {Future} Future object that will be fulfilled when the module will be loaded
         */
        load:function (moduleName, remoteServerPackageFileExtension, downloadFullUrl, subDirectory)
        {
            var self = this;
            var future = new Future();
            var wrap = eh.createWrapperFromFuture(future);

            logger.info("[dynamic-module-loader] Loading " + moduleName + " from " +
              (downloadFullUrl ? downloadFullUrl : self.settings.modulePackageServerUrl));

            // Set the file extension to use when downloading from a remote server.  If we don't have one specified
            // we use the default.
            if (!remoteServerPackageFileExtension)
            {
                logger.info(util.format("[dynamic-module-loader] Remote server package file extension not specified.  Defaulting to '%s'.",
                                        self.settings.defaultRemoteServerPackageFileExtension));
                remoteServerPackageFileExtension = self.settings.defaultRemoteServerPackageFileExtension;
            }

            checkLocalPackageOrDownload();

            return future;

            function checkLocalPackageOrDownload()
            {
                // Look up the main module file from the cache.  If we have one then we try to load it right away.
                // If not, we download it.
                logger.debug(util.format("[dynamic-module-loader] Looking up module %s in module main file cache.", moduleName));
                var moduleMainFile = self.downloadedModuleMainFileCache[moduleName];
                if (moduleMainFile)
                {
                    logger.debug(util.format("[dynamic-module-loader] Module %s maps to main file %s.  Attempting to load it.",
                                             moduleName,
                                             moduleMainFile));
                    // OK, we have the main module file cached under the module name.  We try to load it.
                    var module = nonThrowingRequire(moduleMainFile);
                    if (module)
                    {
                        logger.info(util.format("[dynamic-module-loader] Module %s found and loaded from cache.", moduleName));

                        future.fulfill(undefined, module);
                        return;
                    }

                    // No module.  We have to download it.
                    logger.info(util.format("[dynamic-module-loader] Module %s not found.  Will download", moduleName));
                }

                self.settings.lockManager
                        .obtainExclusiveLock(subDirectory ? subDirectory : moduleName,
                            self.settings.lockOwner, self.settings.downloadLockTimeout)
                        .when(hopefullyObtainedLock);

                function nonThrowingRequire(modulePath)
                {
                    try
                    {
                        return require(modulePath);
                    }
                    catch (err)
                    {
                        return err;
                    }
                }
            }

            function hopefullyObtainedLock(err)
            {
                if (err)
                {
                    var message = util.format(
                        "Unable to download module %s because unable to obtain lock " +
                            "within timeout period of %dms.  This is a " +
                            "recoverable error that can be caused by a slow network or a stressed package " +
                            "server.  You can try to download again or increase the timeout period.  Underlying " +
                            "message: %s",
                        moduleName,
                        self.settings.downloadLockTimeout,
                        err.message);
                    logger.error("[dynamic-module-loader] " + message);
                    future.fulfill(new Error(message), undefined);
                    return;
                }

                // At this point we have the lock so we redefine the wrap method so that it is always released in
                // the event of an error.
                wrap = eh.createWrapperFromCallback(function (err)
                                                    {
                                                        unlockAndFulfill(err, undefined);
                                                    });

                // No module exists locally.  We'll have to download it.
                var moduleCompressedPackageFileName = moduleName + remoteServerPackageFileExtension;
                var moduleDownloadUrl = downloadFullUrl ? downloadFullUrl :
                    self.settings.modulePackageServerUrl + '/' + moduleCompressedPackageFileName;
                var moduleDownloadTargetPath = path.join(self.settings.downloadDir, moduleCompressedPackageFileName);
                var moduleInstallationDir = subDirectory ? path.join(self.settings.moduleInstallationDir, subDirectory)
                    : self.settings.moduleInstallationDir;
                var moduleInstallationPath = path.join(moduleInstallationDir, moduleName);
                logger.debug("[dynamic-module-loader] Full path to module: " + moduleInstallationPath);

                fs.access(moduleInstallationPath, fs.constants.R_OK,
                          function (err)
                          {
                              if (!err)
                              {
                                  // The module exists locally.  We skip the download and install phases.
                                  determineModuleDeployDirectory(moduleInstallationPath,
                                                                 function (installedPath)
                                                                 {
                                                                     loadDownloadedModule(installedPath);
                                                                 });
                              }
                              else
                              {
                                  startDownload();
                              }
                          });

                function startDownload()
                {
                    // First make sure the download directory exists.
                    fs.access(self.settings.downloadDir, fs.constants.R_OK,
                              function (err)
                              {
                                  if (!err)
                                  {
                                      createModuleInstallationDir();
                                  }
                                  else
                                  {
                                      logger.debug(util.format("[dynamic-module-loader] Module download dir %s does not exist.  Creating.", self.settings.downloadDir));
                                      fs.mkdir(self.settings.downloadDir, 0o777, createModuleInstallationDir);
                                  }
                              });
                }

                function createModuleInstallationDir()
                {
                    fs.access(moduleInstallationDir, fs.constants.R_OK,
                              function (err)
                              {
                                  if (!err)
                                  {
                                      ensureNpmExists();
                                  }
                                  else
                                  {
                                      logger.debug(util.format("[dynamic-module-loader] Module installation dir %s does not exist.  Creating.", self.settings.moduleInstallationDir));
                                      fs.mkdirs(moduleInstallationDir, 0o777, wrap(ensureNpmExists));
                                  }
                              });
                }

                function ensureNpmExists()
                {
                    logger.debug(util.format("[dynamic-module-loader] Checking for NPM on path %s.", self.settings.npmExecutablePath));
                    fs.access(self.settings.npmExecutablePath, fs.constants.R_OK,
                              function (err)
                              {
                                  if (!err)
                                  {
                                      logger.debug(util.format("[dynamic-module-loader] NPM found on path %s.", self.settings.npmExecutablePath));
                                      downloadModulePackage();
                                  }
                                  else
                                  {
                                      var message = util.format("[dynamic-module-loader] NPM (Node Package Manager) does not exist at location '%s'.  " +
                                                                    "Make sure it is installed and the path is correctly set.",
                                                                self.settings.npmExecutablePath);
                                      logger.error(message);

                                      unlockAndFulfill(new Error(message), moduleName);
                                  }
                              });
                }

                function downloadModulePackage()
                {
                    logger.info(util.format("[dynamic-module-loader] Downloading module %s from URL %s to %s.",
                                            moduleName,
                                            moduleDownloadUrl,
                                            moduleDownloadTargetPath));

                    var downloadResult = self.__downloadFile(moduleDownloadUrl, moduleDownloadTargetPath);

                    var extractionAlgorithm;
                    if (remoteServerPackageFileExtension === ZIP_SUFFIX)
                    {
                        extractionAlgorithm = uncompressZipFile;
                    }
                    else if (remoteServerPackageFileExtension === TAR_GZIP_SUFFIX)
                    {
                        extractionAlgorithm = extractModulePackageFromTarGzFile;
                    }
                    else
                    {
                        var message = util.format("[dynamic-module-loader] Unknown remote server package file extension specified.  Value was " +
                                                      "'%s'.  Expected one of '%s', '%s'.",
                                                  remoteServerPackageFileExtension, TAR_GZIP_SUFFIX, ZIP_SUFFIX);
                        logger.error(message);

                        unlockAndFulfill(new Error(message), moduleName);
                        return;
                    }

                    downloadResult.when(
                        wrap(function (downloadedFile)
                             {
                                 // Emit the downloaded event then extract the module.
                                 self.emit(self.events.moduleDownloaded, moduleName, downloadedFile,
                                           callbacks.createCountedCallback(
                                               self.listeners(self.events.moduleDownloaded).length,
                                               wrap(function ()
                                                    {
                                                        extractionAlgorithm(downloadedFile);
                                                    })));
                             }));
                }

                function extractModulePackageFromTarGzFile(sourceBundledPackageFilePath)
                {
                    logger.info(util.format("[dynamic-module-loader] Extracting module package %s to %s.",
                                            sourceBundledPackageFilePath,
                                            moduleInstallationPath));
                    tar.extract({
                        file: sourceBundledPackageFilePath,
                        C: self.settings.moduleInstallationDir
                    }).then(() =>
                    {
                        self.emit(self.events.moduleExtracted, moduleName, moduleInstallationPath,
                            callbacks.createCountedCallback(
                                self.listeners(self.events.moduleExtracted).length,
                                wrap(function ()
                                {
                                    installDownloadedModule(moduleInstallationPath);
                                })));
                    }).catch(() =>
                    {
                        logger.error("[dynamic-module-loader] An error occurred during extraction: " + err);
                        unlockAndFulfill(err, undefined);
                    });
                }

                function uncompressZipFile(downloadedFile)
                {
                    logger.info(util.format("[dynamic-module-loader] Uncompressing '%s' to '%s'.",
                                            downloadedFile,
                                            moduleInstallationPath));

                    // Now that we have it downloaded, we have to uncompress it.
                    var uncompressResult = self.__decompressZipFile(downloadedFile, moduleInstallationPath);
                    uncompressResult.when(wrap(function (targetFilePath)
                                               {
                                                   determineModuleDeployDirectory(targetFilePath, emitModuleExtractedEventAndContinue);
                                               }));
                }

                function determineModuleDeployDirectory(targetFilePath, proceed)
                {
                    self.__findPackageJSONFile(targetFilePath)
                        .when(wrap(function (packageJsonFilePath)
                                   {
                                       var containingDirectory = path.dirname(packageJsonFilePath);
                                       logger.debug(util.format("[dynamic-module-loader] Found package.json at location %s.", containingDirectory));
                                       proceed(containingDirectory);
                                   }));
                }

                function emitModuleExtractedEventAndContinue(targetFilePath)
                {
                    self.emit(self.events.moduleExtracted, moduleName, targetFilePath,
                              callbacks.createCountedCallback(
                                  self.listeners(self.events.moduleExtracted).length,
                                  wrap(function ()
                                       {
                                           installDownloadedModule(targetFilePath);
                                       })));
                }

                function installDownloadedModule(packageJsonFileLocation)
                {
                    var packageJSONFile = path.join(packageJsonFileLocation, 'package.json');
                    var packageInfo = JSON.parse(fs.readFileSync(packageJSONFile).toString());
                    logger.info("[dynamic-module-loader] overrideDependencies property: " + packageInfo.overrideDependencies);

                    if (self.settings.preInstalledNodeModulesLocation && packageInfo.overrideDependencies)
                    {
                        var preinstalled_node_modules_dir = path.join(self.settings.preInstalledNodeModulesLocation, 'node_modules');
                        logger.info("[dynamic-module-loader] Copying " + preinstalled_node_modules_dir + " to " + packageJsonFileLocation +
                            " (will delete existing node_modules/ directory if it's present)");
                        rimraf(path.join(packageJsonFileLocation, 'node_modules'), function(err)
                        {
                            if (err)
                            {
                                var message = "[dynamic-module-loader] Error while deleting " + packageJsonFileLocation + "/node_modules: " + err;
                                logger.error(message);
                                unlockAndFulfill(new Error(message), undefined);
                            }
                            else
                            {
                                fs.access(preinstalled_node_modules_dir, fs.constants.R_OK, function(err)
                                {
                                    if (!err)
                                    {
                                        fs.copy(preinstalled_node_modules_dir, path.join(packageJsonFileLocation, 'node_modules'),
                                            { overwrite: true }).then(() => installationComplete(0));
                                    }
                                    else
                                    {
                                        unlockAndFulfill(new Error("[dynamic-module-loader] Cannot find pre-installed node_modules directory."), undefined);
                                    }
                                });
                            }
                        });
                    }
                    else if (self.settings.npmSkipInstall)
                    {
                        logger.info(util.format("[dynamic-module-loader] Skipping NPM install per configuration (npmSkipInstall is set to 'true') for module %s at location %s.",
                                                moduleName,
                                                packageJsonFileLocation));
                        installationComplete(0);
                    }
                    else
                    {
                        logger.info(util.format("[dynamic-module-loader] Installing module %s at location %s.",
                                                moduleName,
                                                packageJsonFileLocation));
                        var options = ['install'];
                        options.concat(self.settings.npmOptions);

                        var npm = spawn(self.settings.npmExecutablePath, options, {cwd:packageJsonFileLocation});

                        npm.stdout.on('data', function (data)
                        {
                            logger.info('npm: ' + data);
                        });
                        npm.stderr.on('data', function (data)
                        {
                            logger.info('npm (stderr): ' + data);
                        });

                        npm.on('exit', function (code)
                        {
                            logger.info(util.format('[dynamic-module-loader] NPM exited with code %d.', code));
                            installationComplete(code);
                        });
                    }

                    function installationComplete(code)
                    {
                        if (code === 0)
                        {
                            if (self.settings.cleanUpEnabled)
                            {
                                var future = self.clean();
                                future.when(emitModuleInstalledEvent);
                            }
                            else
                            {
                                emitModuleInstalledEvent();
                            }
                        }
                        else
                        {
                            // Oh dear.  Something went wrong.
                            var message = util.format("[dynamic-module-loader] NPM (%s) failed to install downloaded module '%s'.  Exit " +
                                                          "code was %d.  See log for details.",
                                                      self.settings.npmExecutablePath,
                                                      packageJsonFileLocation,
                                                      code);
                            logger.error(message);

                            unlockAndFulfill(new Error(message), undefined);
                        }
                    }

                    function emitModuleInstalledEvent()
                    {
                        // Hah!  Success!
                        self.emit(self.events.moduleInstalled, moduleName, packageJsonFileLocation,
                            callbacks.createCountedCallback(
                                self.listeners(self.events.moduleInstalled).length,
                                wrap(function ()
                                {
                                    loadDownloadedModule(packageJsonFileLocation);
                                })));
                    }
                }

                function loadDownloadedModule(targetInstallationPath)
                {
                    logger.info(util.format("[dynamic-module-loader] Loading downloaded module %s from %s.",
                                            moduleName,
                                            targetInstallationPath));

                    var targetModulePackageJSONFile = path.join(targetInstallationPath, 'package.json');

                    logger.debug(util.format("[dynamic-module-loader] Reading module %s package file %s.",
                                             moduleName,
                                             targetModulePackageJSONFile));
                    fs.readFile(targetModulePackageJSONFile, wrap(parsePackageData));

                    function parsePackageData(packageData)
                    {
                        logger.debug(util.format("[dynamic-module-loader] Module %s package data: %s", moduleName, packageData));
                        var packageInfo = JSON.parse(packageData);
                        var mainFile = packageInfo.main;
                        if (!mainFile)
                        {
                            mainFile = path.normalize('./lib/index.js');
                            logger.info(util.format("[dynamic-module-loader] Module %s package data contains no entry for 'main'.  Defaulting to %s.",
                                                    moduleName,
                                                    mainFile));
                        }

                        var mainModuleFilePath = path.join(targetInstallationPath, mainFile);
                        logger.info(util.format("[dynamic-module-loader] Module %s full name path is %s.",
                                                moduleName,
                                                mainModuleFilePath));

                        try
                        {
                            module = require(mainModuleFilePath);
                        }
                        catch (err)
                        {
                            var message = util.format("[dynamic-module-loader] Unable to load module %s from target installation path %s. (%s)",
                                                      moduleName,
                                                      mainModuleFilePath,
                                                      err.message);
                            logger.error(message);
                            logger.error(err.stack);

                            unlockAndFulfill(new Error(message), undefined);
                            return;
                        }

                        // Cache the main module file under the module path.
                        logger.debug(util.format("[dynamic-module-loader] Caching main file path %s for module %s.",
                                                 mainModuleFilePath,
                                                 moduleName));
                        self.downloadedModuleMainFileCache[moduleName] = mainModuleFilePath;

                        // Tell the caller that we downloaded the module.
                        logger.info(util.format("[dynamic-module-loader] Module %s downloaded and loaded successfully.",
                                                moduleName));

                        self.emit(self.events.moduleLoaded, moduleName,
                                  callbacks.createCountedCallback(
                                      self.listeners(self.events.moduleLoaded).length,
                                      wrap(function ()
                                           {
                                               unlockAndFulfill(undefined, module);
                                           })));
                    }
                }

                function unlockAndFulfill(err, module)
                {
                    if (!err)
                    {
                        unlockAndFinish();
                        return;
                    }
                    if (err)
                    {
                        logger.error(err.message);
                        logger.error(err.stack);

                        var targetErrorInstallationDir = moduleInstallationPath + "-ERROR";

                        function pathExists(path, existsFn, doesNotExistFn)
                        {
                            fs.access(path, fs.constants.R_OK, function (err)
                            {
                                err ? doesNotExistFn() : existsFn();
                            });
                        }

                        // Clean up the installation directory in the event of an error.  Well, we actually just
                        // rename the directory to something else to pave the way for a subsequent retry.  That
                        // way the problematic directory is kept around for future inspection.
                        pathExists(moduleInstallationPath, moduleInstallationPathExists, unlockAndFinish);

                        function moduleInstallationPathExists()
                        {
                            logger.info(util.format('[dynamic-module-loader] Renaming directory %s to %s due to an installation error.',
                                moduleDownloadTargetPath, targetErrorInstallationDir));

                            pathExists(targetErrorInstallationDir, deleteInstallationDir, renameInstallationDirToErrorDir);
                        }

                        function deleteInstallationDir()
                        {
                            logger.info(util.format("[dynamic-module-loader] An error directory for this package (%s) already exists. " +
                                "Will not create a new one.", targetErrorInstallationDir));
                            logger.info(util.format("[dynamic-module-loader] Deleting %s.", moduleInstallationPath));

                            fs.remove(moduleInstallationPath, function(err)
                            {
                                if (err)
                                {
                                    logger.error(err.message);
                                    logger.error(err.stack);

                                    logger.warn(util.format("[dynamic-module-loader] Error deleting %s. Will continue.", moduleInstallationPath));
                                }

                                unlockAndFinish();
                            });
                        }

                        function renameInstallationDirToErrorDir()
                        {
                            logger.info(util.format('[dynamic-module-loader] Renaming directory %s to %s due to an installation error.',
                                moduleInstallationPath, targetErrorInstallationDir));

                            fs.rename(moduleInstallationPath, targetErrorInstallationDir, function (renameError)
                            {
                                if (renameError)
                                {
                                    // Oh dear.  Very sick computer.
                                    logger.error(util.format("[dynamic-module-loader] An error occurred during cleanup of install directory " +
                                        "%s.  Could not rename it to %s.  Message is: ",
                                        moduleInstallationPath,
                                        targetErrorInstallationDir,
                                        deletionError.message));
                                }

                                unlockAndFinish();
                            });
                        }
                    }

                    function unlockAndFinish()
                    {
                        self.settings.lockManager.releaseExclusiveLock(subDirectory ? subDirectory : moduleName, self.settings.lockOwner)
                            .when(function(unlockError)
                            {
                                // Give preference to the original error.  If there's no original error, use the unlock error.
                                // If there's no unlock error, we'll fulfill with an undefined error, which means everything
                                // worked.
                                future.fulfill(err ? err : unlockError, module);
                            });
                    }
                }
            }
        },


        /**
         * Evict a module from memory, next time requested it will be reloaded based on the disk
         * @param moduleName name of the module to evict
         * @param subDirectory name of the sub directory where the module has been installed
         *                     (optional, to set if you have specified it in the load() function)
         * @return Future A future object that will be fulfill upon eviction.
         */
        evict: function (moduleName, subDirectory)
        {
            var self = this;
            var future = new Future();
            self.settings.lockManager
                .obtainExclusiveLock(moduleName, self.settings.lockOwner, self.settings.downloadLockTimeout)
                .when(__destroy);

            return future;

            function __destroy()
            {
                try
                {
                    var moduleMainFile = self.downloadedModuleMainFileCache[moduleName];
                    if (moduleMainFile)
                    {
                        var module = require(moduleMainFile);
                        if (module && _.isFunction(module.destroy))
                        {
                            // NOTE(ovaussy - 9/26/13): If the destroy function doesn't call our call back then the module will never be evicted.
                            module.destroy(function (err)
                                           {
                                               if (err)
                                               {
                                                   logger.warn("[dynamic-module-loader] An error occurred while destroying the module, the eviction will go on", err);
                                               }
                                               else
                                               {
                                                   self.emit(self.events.moduleDestroyed, moduleName);
                                               }
                                               __evict();
                                           });
                        }
                        else
                        {
                            __evict();
                        }
                    }
                    else
                    {
                        __evict();
                    }
                }
                catch (e)
                {
                    logger.warn("[dynamic-module-loader] An error occurred while destroying the module, the eviction will go on", e);
                    __evict();
                }
            }

            function __evict()
            {
                var moduleInstallationPath;
                if (subDirectory) {
                    moduleInstallationPath = path.join(self.settings.moduleInstallationDir, subDirectory, moduleName);
                }
                else {
                    moduleInstallationPath = path.join(self.settings.moduleInstallationDir, moduleName);
                }
                delete self.downloadedModuleMainFileCache[moduleName];
                for (var key in require.cache)
                {
                    if (startsWith(key, moduleInstallationPath + '/'))
                    {
                        logger.debug("[dynamic-module-loader] removing : " + key);
                        delete require.cache[key];
                    }
                }
                try
                {
                    self.emit(self.events.moduleEvicted, moduleName);
                }
                catch (e)
                {
                    logger.error("[dynamic-module-loader] Error occurred while emitting the event moduleEvicted", e);
                }
                self.settings.lockManager.releaseExclusiveLock(moduleName, self.settings.lockOwner)
                    .when(__res);
            }

            function __res(err)
            {
                future.fulfill(err, moduleName);
            }
        },

        /**
         * Clean up method called if activated in the dynamic loader configuration.
         * The method is quite minimalist but it can be overriden by the client if it wants to improve it.
         * By default it calls an executable, if the path is provided in the configuration.
         * The executable has to be implemented and provided by the client as well.
         */
        clean: function()
        {
            var self = this;
            var future = new Future();
            fs.access(self.settings.cleanUpExecutablePath, fs.constants.R_OK, function (err)
            {
                logger.debug("[dynamic-module-loader] trying to call cleaning executable");
                if (!err)
                {
                    var cleanUpArgs = self.settings.cleanUpScriptArguments.split(",");
                    var cleanup = spawn(self.settings.cleanUpExecutablePath, cleanUpArgs);

                    cleanup.stderr.on('data', function (data)
                    {
                        logger.error('[dynamic-module-loader] clean up stderr: ' + data);
                    });

                    // End the response on zip exit
                    cleanup.on('exit', function (code)
                    {
                        if (code === 0)
                        {
                            logger.debug("[dynamic-module-loader] eh eh! the clean up script worked fine");
                            // the clean up worked fine
                            future.fulfill(undefined);
                        }
                        else
                        {
                            var message = util.format("[dynamic-module-loader] Error with code %d while calling clean up script %s.  See log for " +
                                "details.",
                                code,
                                self.settings.unzipExecutablePath);
                            logger.error(message);
                            future.fulfill(new Error(message), undefined);
                        }
                    });
                }
                else
                {
                    logger.warn(util.format("[dynamic-module-loader] Unable to find clean up script %s", self.settings.cleanUpExecutablePath));
                    future.fulfill(undefined);
                }
            });
            return future;
        },

        /**
         * Downloads the file specified in the sourceUrl to the targetFilePath. This version
         * writes down a chunk of data at once on the file system and it is suitable for very
         * large files as well.
         * @param sourceUrl file to download source url
         * @param targetFilePath file system location where to save the file
         * @returns {Future} A future object that will be fulfill upon download completed
         */
        __downloadFile:function (sourceUrl, targetFilePath)
        {
            var future = new Future();

            logger.debug(util.format("[dynamic-module-loader] Attempting to download %s to %s.", sourceUrl, targetFilePath));

            var returnError = function (status, errorMessage) {
                var message = util.format("[dynamic-module-loader] Unable to download from %s to %s.  %s",
                    sourceUrl,
                    targetFilePath,
                    errorMessage);
                logger.error(message, errorMessage);
                var error = new Error(message);
                error.statusCode = status;
                future.fulfill(error, undefined);
            };
            
            // To distinguish the case protocol: http:// from the case protocol: file://...
            var uri = url.parse(sourceUrl);
            
            if(uri.protocol == 'http:' || uri.protocol == 'https:')
            {
                // Case http:// ...
                var requester = startsWith(sourceUrl, "https") ? https : http;
                requester.get(sourceUrl, function (res) {
                    if (res.statusCode !== 200)
                    {
                        returnError(res.statusCode, util.format("Status code %d.", res.statusCode));
                        return;
                    }

                    var downloadFile = fs.createWriteStream(targetFilePath);

                    res.on('data', function (chunk) {
                        downloadFile.write(chunk);
                    });

                    res.on('end', function() {
                        // We don't listen to the 'finish' event because that was changed somewhere between 0.8.x and
                        // 0.10.x. It used to be called 'close' but the goats at Joyent decided to introduce an incompatible
                        // API change with no notification of deprecation or indeed any support for the old version for a
                        // meaningful period of time.
                        downloadFile.end(function() {
                            logger.debug(util.format("[dynamic-module-loader] Finished downloading %s", targetFilePath));
                            future.fulfill(undefined, targetFilePath);
                        });
                    });
                }).on('error', function(err){
                    returnError(undefined, util.format("Error: %s", err));
                });
            }
            else if(uri.protocol == 'file:')
            {
                // Case file:// ...
                var rd = fs.createReadStream(uri.path);

                rd.on("error", function(err) {
                    returnError(undefined, util.format("Cannot open input file: %s", uri.path));
                });

                var wr = fs.createWriteStream(targetFilePath);

                wr.on("error", function(err) {
                    returnError(undefined, util.format("Cannot open output file: %s", targetFilePath));
                });

                wr.on("close", function() {
                    logger.debug(util.format("[dynamic-module-loader] Finished copying %s", targetFilePath));
                    future.fulfill(undefined, targetFilePath);
                });

                rd.pipe(wr);
            }
            else
            {
                // Case unknown protocol ...
                returnError(undefined, util.format("Unknown protocol: %s", uri.protocol));
            }

            return future;
        },

        __decompressZipFile:function (sourceFilePath, targetFilePath)
        {
            var self = this;

            var future = new Future();
            var wrap = eh.createWrapperFromFuture(future);

            logger.debug(util.format("[dynamic-module-loader] Unzipping '%s' to '%s'.", sourceFilePath, targetFilePath));

            // Create the target directory.
            fs.mkdir(targetFilePath, 0o777, wrap(extractZip));

            return future;

            function extractZip()
            {
                var unzip = spawn(self.settings.unzipExecutablePath, ['-o', sourceFilePath, '-d', targetFilePath]);

                unzip.stdout.on('data', function (data)
                {
                    logger.info("unzip: " + data);
                });

                unzip.stderr.on('data', function (data)
                {
                    logger.error('unzip stderr: ' + data);
                });

                // End the response on zip exit
                unzip.on('exit', function (code)
                {
                    if (code === 0)
                    {
                        // Success.
                        future.fulfill(undefined, targetFilePath);
                    }
                    else
                    {
                        // Oh dear.  Something went wrong.
                        var message = util.format("[dynamic-module-loader] Unable to unzip file '%s'.  Exit code of '%s' was %d.  See log for " +
                                                      "details.",
                                                  sourceFilePath,
                                                  self.settings.unzipExecutablePath,
                                                  code);
                        logger.error(message);
                        future.fulfill(new Error(message), undefined);
                    }
                });
            }
        },


        __findPackageJSONFile:function (rootDir)
        {
            var future = new Future();
            var wrap = eh.createWrapperFromFuture(future);

            if(/^win/.test(process.platform))
            {
                exec('dir /B /S ' + rootDir + '\\package.json', wrap(getTopLevelFile));
            }
            else
            {
                execFile('find', [ rootDir, '-name', 'package.json' ], wrap(getTopLevelFile));
            }

                function getTopLevelFile (stdout)
                {
                    stdout = trim(stdout);
                    if (stdout === "")
                    {
                        var message = util.format('[dynamic-module-loader] Unable to find package.json file in directory %s or any of its sub directories.', rootDir);
                        logger.error(message);
                        future.fulfill(new Error(message));
                        return;
                    }

                    var files = stdout.split('\n').sort();
                    files.sort(function (left, right)
                               {
                                   return left.length - right.length;
                               });
                    future.fulfill(undefined, files[0]);
                }

            return future;
        }
    });

module.paths.push('/');
module.exports = DynamicModuleLoader;
