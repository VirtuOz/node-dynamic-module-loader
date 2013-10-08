/*
 * Copyright 2012 VirtuOz Inc. All rights reserved.
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
var execFile = require('child_process').execFile;
var util = require('util');
var path = require('path');
var events = require('events');
var url = require('url');
var http = require('http');
var https = require('https');
var fs = require('node-fs');
var zlib = require('zlib');

var eh = require('error-handling');
var LockManager = require('hurt-locker').LockManager;
var callbacks = require('callback-utils');
var _ = require('underscore');
_.str = require('underscore.string');
var extend = require('xtend');

require('jsclass');
JS.require('JS.Class');

var winston = require('winston');
var logger = winston.loggers.get('dynamic-module-loader');

var TAR_SUFFIX = ".tar";
var GZIP_SUFFIX = ".gz";
var TAR_GZIP_SUFFIX = TAR_SUFFIX + GZIP_SUFFIX;
var ZIP_SUFFIX = ".zip";

var config = require('./dml_config');

var DynamicModuleLoader = new JS.Class(
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

        initialize:function (settings)
        {
            events.EventEmitter.call(this);

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
                extend(this.settings, settings);
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
         * @returns {Future} Future object that will be fulfilled when the module will be loaded
         */
        load:function (moduleName, remoteServerPackageFileExtension, downloadFullUrl)
        {
            var self = this;
            var future = new Future();
            var wrap = eh.createWrapperFromFuture(future);

            logger.info("Loading " + moduleName + ". from " + downloadFullUrl ?
                                                                downloadFullUrl :
                                                                self.settings.modulePackageServerUrl);

            // Set the file extension to use when downloading from a remote server.  If we don't have one specified
            // we use the default.
            if (!remoteServerPackageFileExtension)
            {
                logger.info(util.format("Remote server package file extension not specified.  Defaulting to '%s'.",
                                        self.settings.defaultRemoteServerPackageFileExtension));
                remoteServerPackageFileExtension = self.settings.defaultRemoteServerPackageFileExtension;
            }

            checkLocalPackageOrDownload();

            return future;

            function checkLocalPackageOrDownload()
            {
                // Look up the main module file from the cache.  If we have one then we try to load it right away.
                // If not, we download it.
                logger.debug(util.format("Looking up module %s in module main file cache.", moduleName));
                var moduleMainFile = self.downloadedModuleMainFileCache[moduleName];
                if (moduleMainFile)
                {
                    logger.debug(util.format("Module %s maps to main file %s.  Attempting to load it.",
                                             moduleName,
                                             moduleMainFile));
                    // OK, we have the main module file cached under the module name.  We try to load it.
                    var module = nonThrowingRequire(moduleMainFile);
                    if (module)
                    {
                        logger.info(util.format("Module %s found and loaded from cache.", moduleName));

                        future.fulfill(undefined, module);
                        return;
                    }

                    // No module.  We have to download it.
                    logger.info(util.format("Module %s not found.  Will download", moduleName));
                }

                self.settings.lockManager
                        .obtainExclusiveLock(moduleName, self.settings.lockOwner, self.settings.downloadLockTimeout)
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
                    logger.error("DynamicModuleLoader: " + message);
                    future.fulfill(new Error(message), undefined);
                    return;
                }

                // At this point we have the lock so we redefine the wrap method so that it is always released in
                // the event of an error.
                wrap = eh.createWrapperFromCallback(function (err)
                                                    {
                                                        unlockAndFulfill(err, undefined);
                                                    });

                var fullModulePath = path.join(self.settings.moduleInstallationDir, moduleName);
                logger.debug("Full path to module: " + fullModulePath);

                // No module exists locally.  We'll have to download it.
                var moduleCompressedPackageFileName = moduleName + remoteServerPackageFileExtension;
                var moduleDownloadUrl = downloadFullUrl ? downloadFullUrl :
                    self.settings.modulePackageServerUrl + '/' + moduleCompressedPackageFileName;
                var moduleDownloadTargetPath = path.join(self.settings.downloadDir, moduleCompressedPackageFileName);
                var moduleInstallationPath = path.join(self.settings.moduleInstallationDir, moduleName);

                fs.exists(moduleInstallationPath,
                          function (exists)
                          {
                              if (exists)
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
                    fs.exists(self.settings.downloadDir,
                              function (exists)
                              {
                                  if (exists)
                                  {
                                      createModuleInstallationDir();
                                  }
                                  else
                                  {
                                      logger.debug(util.format("Module download dir %s does not exist.  Creating.", self.settings.downloadDir));
                                      fs.mkdir(self.settings.downloadDir, 0777, true, createModuleInstallationDir);
                                  }
                              });
                }

                function createModuleInstallationDir()
                {
                    fs.exists(self.settings.moduleInstallationDir,
                              function (exists)
                              {
                                  if (exists)
                                  {
                                      ensureNpmExists();
                                  }
                                  else
                                  {
                                      logger.debug(util.format("Module installation dir %s does not exist.  Creating.", self.settings.moduleInstallationDir));
                                      fs.mkdir(self.settings.moduleInstallationDir, 0777, true, wrap(ensureNpmExists));
                                  }
                              });
                }

                function ensureNpmExists()
                {
                    logger.debug(util.format("Checking for NPM on path %s.", self.settings.npmExecutablePath));
                    fs.exists(self.settings.npmExecutablePath,
                              function (exists)
                              {
                                  if (exists)
                                  {
                                      logger.debug(util.format("NPM found on path %s.", self.settings.npmExecutablePath));
                                      downloadModulePackage();
                                  }
                                  else
                                  {
                                      var message = util.format("NPM (Node Package Manager) does not exist at location '%s'.  " +
                                                                    "Make sure it is installed and the path is correctly set.",
                                                                self.settings.npmExecutablePath);
                                      logger.error(message);

                                      unlockAndFulfill(new Error(message), moduleName);
                                  }
                              });
                }

                function downloadModulePackage()
                {
                    logger.info(util.format("Downloading module %s from URL %s to %s.",
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
                        extractionAlgorithm = uncompressTarGzFile;
                    }
                    else
                    {
                        var message = util.format("Unknown remote server package file extension specified.  Value was " +
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

                function uncompressTarGzFile(downloadedFile)
                {
                    var modulePackageFileName = moduleName + TAR_SUFFIX;
                    var moduleDecompressTargetPath = path.join(self.settings.downloadDir, modulePackageFileName);

                    logger.info(util.format("Uncompressing '%s' to '%s'.",
                                            downloadedFile,
                                            moduleDecompressTargetPath));

                    // Now that we have it downloaded, we have to uncompress it.
                    var uncompressResult = self.__decompressTarFile(downloadedFile, moduleDecompressTargetPath);
                    uncompressResult.when(wrap(extractModulePackageFromTarFile));
                }

                function extractModulePackageFromTarFile(sourceBundledPackageFilePath)
                {
                    logger.info(util.format("Extracting module package %s to %s.",
                                            sourceBundledPackageFilePath,
                                            moduleInstallationPath));
                    fs.createReadStream(sourceBundledPackageFilePath)
                        .pipe(tar.Extract({ path:self.settings.moduleInstallationDir }))
                        .on("error", function (err)
                            {
                                logger.error("An error occurred during extraction: " + err);
                                unlockAndFulfill(err, undefined);
                            })
                        .on("end", function ()
                            {
                                self.emit(self.events.moduleExtracted, moduleName, moduleInstallationPath,
                                          callbacks.createCountedCallback(
                                              self.listeners(self.events.moduleExtracted).length,
                                              wrap(function ()
                                                   {
                                                       installDownloadedModule(moduleInstallationPath);
                                                   })));
                            });
                }

                function uncompressZipFile(downloadedFile)
                {
                    logger.info(util.format("Uncompressing '%s' to '%s'.",
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
                                       logger.debug(util.format("Found package.json at location %s.", containingDirectory));
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

                function installDownloadedModule(moduleInstallationPath)
                {
                    if (self.settings.npmSkipInstall)
                    {
                        logger.info(util.format("Skipping NPM install per configuration (npmSkipInstall is set to 'true') for module %s at location %s.",
                                                moduleName,
                                                moduleInstallationPath));
                        installationComplete(0);
                    }
                    else
                    {
                        logger.info(util.format("Installing module %s at location %s.",
                                                moduleName,
                                                moduleInstallationPath));
                        var options = ['install'];
                        options.concat(self.settings.npmOptions);

                        var npm = spawn(self.settings.npmExecutablePath, options, {cwd:moduleInstallationPath});

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
                            logger.info(util.format('NPM exited with code %d.', code));
                            installationComplete(code);
                        });
                    }

                    function installationComplete(code)
                    {
                        if (code === 0)
                        {
                            // Hah!  Success!
                            self.emit(self.events.moduleInstalled, moduleName, moduleInstallationPath,
                                      callbacks.createCountedCallback(
                                          self.listeners(self.events.moduleInstalled).length,
                                          wrap(function ()
                                               {
                                                   loadDownloadedModule(moduleInstallationPath);
                                               })));
                        }
                        else
                        {
                            // Oh dear.  Something went wrong.
                            var message = util.format("NPM (%s) failed to install downloaded module '%s'.  Exit " +
                                                          "code was %d.  See log for details.",
                                                      self.settings.npmExecutablePath,
                                                      moduleInstallationPath,
                                                      code);
                            logger.error(message);

                            unlockAndFulfill(new Error(message), undefined);
                        }
                    }
                }

                function loadDownloadedModule(targetInstallationPath)
                {
                    logger.info(util.format("Loading downloaded module %s from %s.",
                                            moduleName,
                                            targetInstallationPath));

                    var targetModulePackageJSONFile = path.join(targetInstallationPath, 'package.json');

                    logger.debug(util.format("Reading module %s package file %s.",
                                             moduleName,
                                             targetModulePackageJSONFile));
                    fs.readFile(targetModulePackageJSONFile, wrap(parsePackageData));

                    function parsePackageData(packageData)
                    {
                        logger.debug(util.format("Module %s package data: %s", moduleName, packageData));
                        var packageInfo = JSON.parse(packageData);
                        var mainFile = packageInfo.main;
                        if (!mainFile)
                        {
                            mainFile = path.normalize('./lib/index.js');
                            logger.info(util.format("Module %s package data contains no entry for 'main'.  Defaulting to %s.",
                                                    moduleName,
                                                    mainFile));
                        }

                        var mainModuleFilePath = path.join(targetInstallationPath, mainFile);
                        logger.info(util.format("Module %s full name path is %s.",
                                                moduleName,
                                                mainModuleFilePath));

                        try
                        {
                            module = require(mainModuleFilePath);
                        }
                        catch (err)
                        {
                            var message = util.format("Unable to load module %s from target installation path %s. (%s)",
                                                      moduleName,
                                                      mainModuleFilePath,
                                                      err.message);
                            logger.error(message);
                            logger.error(err.stack);

                            unlockAndFulfill(new Error(message), undefined);
                            return;
                        }

                        // Cache the main module file under the module path.
                        logger.debug(util.format("Caching main file path %s for module %s.",
                                                 mainModuleFilePath,
                                                 moduleName));
                        self.downloadedModuleMainFileCache[moduleName] = mainModuleFilePath;

                        // Tell the caller that we downloaded the module.
                        logger.info(util.format("Module %s downloaded and loaded successfully.",
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
                    self.settings.lockManager.releaseExclusiveLock(moduleName, self.settings.lockOwner)
                        .when(cleanUp);

                    function cleanUp(unlockError)
                    {
                        if (unlockError)
                        {
                            // An error happened during unlock but we (possibly) loaded the module.  At this point
                            // everything is broken.  Not much to be done about it except complain to OPs.
                            logger.error(util.format("An error occurred during lock release for module %s.  Message is: %s", moduleName, unlockError.message));
                        }

                        if (err)
                        {
                            logger.error(err.message);
                            logger.error(err.stack);

                            // Clean up the installation directory in the event of an error.  Well, we actually just
                            // rename the directory to something else to pave the way for a subsequent retry.  That
                            // way the problematic directory is kept around for future inspection.
                            fs.exists(moduleInstallationPath, function (exists)
                            {
                                if (exists)
                                {
                                    var targetErrorInstallationDir = moduleInstallationPath + "-ERROR-" + randomString(25);

                                    logger.info(util.format('Renaming directory %s to %s due to an installation error.',
                                                            moduleDownloadTargetPath, targetErrorInstallationDir));

                                    fs.rename(moduleInstallationPath, targetErrorInstallationDir, function (renameError)
                                    {
                                        if (renameError)
                                        {
                                            // Oh dear.  Very sick computer.
                                            logger.error(util.format("An error occurred during cleanup of install directory " +
                                                                         "%s.  Could not rename it to %s.  Message is: ",
                                                                     moduleInstallationPath,
                                                                     targetErrorInstallationDir,
                                                                     deletionError.message));
                                        }

                                        fulfill(err ? err : renameError);
                                    });
                                }
                                else
                                {
                                    fulfill(err ? err : unlockError);
                                }
                            });
                        }
                        else
                        {
                            // Give preference to the original error.  If there's no original error, use the unlock error.
                            // If there's no unlock error, we'll fulfill with an undefined error, which means everything
                            // worked.
                            fulfill(err ? err : unlockError);
                        }
                    }


                    function randomString(length)
                    {
                        var chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZabcdefghiklmnopqrstuvwxyz'.split('');

                        if (!length)
                        {
                            length = Math.floor(Math.random() * chars.length);
                        }

                        var str = '';
                        for (var i = 0; i < length; i++)
                        {
                            str += chars[Math.floor(Math.random() * chars.length)];
                        }
                        return str;
                    }


                    function fulfill(errorToUse)
                    {
                        future.fulfill(errorToUse, module);
                    }
                }
            }
        },

        /**
         * Evict a module from memory, next time requested it will be reloaded based on the disk
         * @param moduleName name of the module to evict
         * @return Future A future object that will be fulfill upon eviction.
         */
        evict: function (moduleName)
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
                                                   logger.warn("An error occurred while destroying the module, the eviction will go on", err);
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
                }
                catch (e)
                {
                    logger.warn("An error occurred while destroying the module, the eviction will go on", e);
                    __evict();
                }
            }

            function __evict()
            {
                var moduleInstallationPath = path.join(self.settings.moduleInstallationDir, moduleName);
                delete self.downloadedModuleMainFileCache[moduleName];
                for (var key in require.cache)
                {
                    if (_.str.startsWith(key, moduleInstallationPath + '/'))
                    {
                        logger.debug("removing : " + key);
                        delete require.cache[key];
                    }
                }
                try
                {
                    self.emit(self.events.moduleEvicted, moduleName);
                }
                catch (e)
                {
                    logger.error("Error occurred while emitting the event moduleEvicted", e);
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

            logger.debug(util.format("Attempting to download %s to %s.", sourceUrl, targetFilePath));

            var returnError = function (status, errorMessage) {
                var message = util.format("Unable to download from %s to %s.  %s",
                    sourceUrl,
                    targetFilePath,
                    errorMessage);
                logger.error(message, errorMessage);
                var error = new Error(message);
                error.statusCode = status;
                future.fulfill(error, undefined);
            };
            var requester = _.str.startsWith(sourceUrl, "https") ? https : http;
            requester.get(sourceUrl, function (res) {
                if (res.statusCode !== 200)
                {
                    returnError(res.statusCode, util.format("Status code %d.", res.statusCode));
                    return;
                }

                var downloadFile = fs.createWriteStream(targetFilePath);
                downloadFile.on('finish', function () {
                    logger.debug(util.format("Finished downloading %s", targetFilePath));
                    future.fulfill(undefined, targetFilePath);
                });

                res.on('data', function (chunk) {
                    downloadFile.write(chunk);
                });

                res.on('end', function() {
                    downloadFile.end();
                });
            }).on('error', function(err){
                returnError(undefined, util.format("Error: %s", err));
            });

            return future;
        },

        __decompressTarFile:function (sourceFilePath, targetFilePath)
        {
            logger.debug(util.format("Decompressing '%s' to '%s'.", sourceFilePath, targetFilePath));

            var future = new Future();

            var gunzip = zlib.createGunzip();
            var is = fs.createReadStream(sourceFilePath).on('error', handleStreamError);
            var os = fs.createWriteStream(targetFilePath).on('error', handleStreamError);
            os.on("close", function ()
            {
                future.fulfill(undefined, targetFilePath);
            });
            is.pipe(gunzip).pipe(os);

            return future;

            function handleStreamError(err)
            {
                logger.error(util.format("An error occurred during decompression of %s to %s.  Error: %s",
                                         sourceFilePath, targetFilePath, err));

                // Delete the target file, if it exists.  No sense in littering rubbish around the place.
                if (fs.existsSync(targetFilePath))
                {
                    fs.unlinkSync(targetFilePath);
                }
                future.fulfill(err, undefined);
            }
        },

        __decompressZipFile:function (sourceFilePath, targetFilePath)
        {
            var self = this;

            var future = new Future();
            var wrap = eh.createWrapperFromFuture(future);

            logger.debug(util.format("Unzipping '%s' to '%s'.", sourceFilePath, targetFilePath));

            // Create the target directory.
            fs.mkdir(targetFilePath, 0777, wrap(extractZip));

            return future;

            function extractZip()
            {
                var unzip = spawn(self.settings.unzipExecutablePath, [sourceFilePath, '-d', targetFilePath]);

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
                        var message = util.format("Unable to unzip file '%s'.  Exit code of '%s' was %d.  See log for " +
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

            execFile('find', [ rootDir, '-name', 'package.json' ], wrap(
                function (stdout)
                {
                    stdout = _.str.trim(stdout);
                    if (stdout === "")
                    {
                        var message = util.format('Unable to find package.json file in directory %s or any of its sub directories.', rootDir);
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
                }));

            return future;
        }
    });

module.paths.push('/');
module.exports = DynamicModuleLoader;