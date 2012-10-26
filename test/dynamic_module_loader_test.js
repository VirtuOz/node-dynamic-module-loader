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
 * dynamic_module_loader_test
 *
 * @author Kevan Dunsmore
 * @created 2012/08/26
 */
var Future = require('futures').future;
var expect = require('chai').expect;
var fs = require('fs');
var util = require('util');
var wrench = require('wrench');
var nock = require('nock');
var zlib = require('zlib');
var os = require('os');
var tar = require('tar');
var fstream = require('fstream');
var path = require('path');
var exec = require('child_process').exec;

var VNodeLib = require('../../vnodelib/lib/vnodelib');
var DynamicModuleLoader = VNodeLib.load('dynamic-module-loader').DynamicModuleLoader;
var _ = VNodeLib.load('underscore-extensions');
_.str = require('underscore.string');

var LockManager = VNodeLib.load('cluster-lock').LockManager;

var logger = require('winston');

describe('DynamicModuleLoaderTest', function ()
{
    var rootDir = path.join(__dirname, "/../../");
    var tmpDir = path.join(rootDir, 'target/DynamicModuleLoaderTest-tmp');

    var dynamicModuleName = 'test-dynamic-module';
    var resourceDir = path.join(__dirname, '/resources');
    var dynamicModuleResourceDir = path.join(resourceDir, dynamicModuleName);
    var dynamicModuleFilePath = path.join(tmpDir, '/' + dynamicModuleName);

    var dynamicModuleTarFilePath = dynamicModuleFilePath + '.tar';
    var dynamicModuleTarGzipFilePath = dynamicModuleTarFilePath + ".gz";

    var dynamicModuleZipFilePath = dynamicModuleFilePath + ".zip";
    var dynamicModuleZipFileNoRootDirPath = dynamicModuleFilePath + "-no-root-dir.zip";

    var lockManager;
    var dynamicModuleLoader;

    beforeEach(function (done)
               {
                   // Get rid of the temp directory before we start the test.
                   if (fs.existsSync(tmpDir))
                   {
                       wrench.rmdirSyncRecursive(tmpDir, true);
                   }
                   // Create the module loader to be tested.
                   dynamicModuleLoader = new DynamicModuleLoader();

                   // Create the various directories we'll need.
                   dynamicModuleLoader.setDownloadDir(path.join(tmpDir + "/downloads"));
                   dynamicModuleLoader.setModuleInstallationDir(path.join(tmpDir + "/installed-modules"));
                   dynamicModuleLoader.setModulePackageServerUrl("http://gattacus");

                   lockManager = new LockManager();
                   lockManager.setLockDir(path.join(tmpDir, "/locks"));
                   dynamicModuleLoader.setLockManager(lockManager);

                   wrench.mkdirSyncRecursive(tmpDir);

                   // In preparation for our test, we tar and compress up the test dynamic module.
                   fstream.Reader({path:dynamicModuleResourceDir, type:"Directory"})
                       .pipe(tar.Pack())
                       .pipe(zlib.createGzip())
                       .pipe(fstream.Writer(dynamicModuleTarGzipFilePath).on('close', function (err)
                   {
                       expect(err).to.equal(undefined);
                       zipTestModule();
                   }));

                   // We also zip the test module.
                   // NOTE 2012/09/24 KTD: We have to spawn the zip program because the zip support in Node is
                   // atrocious.  Please note that this will very likely *not* work on Windows, at least not without
                   // Cygwin.
                   function zipTestModule()
                   {
                       execZip(util.format("-rq %s %s", dynamicModuleZipFilePath, dynamicModuleName), resourceDir, zipTestModuleWithNoRootDir);
                   }

                   function zipTestModuleWithNoRootDir()
                   {
                       execZip(util.format("-rv %s *", dynamicModuleZipFileNoRootDirPath), dynamicModuleResourceDir, done);
                   }

                   function execZip(params, resourceDir, next)
                   {
                       // Using this form of child process execution because spawn doesn't work for wildcards when
                       // calling zip.  The zip process exits with code "12", saying that it has nothing to do.
                       exec("zip " + params, {cwd:resourceDir}, function (error, stdout, stderr)
                       {
                           if (error)
                           {
                               console.log(stdout);
                               console.log(stderr);
                           }

                           expect(error).to.equal(null);

                           next();
                       });
                   }
               });

    describe('accessors and mutators', function ()
    {
        it('should get and set the lock location', function (done)
        {
            expect(dynamicModuleLoader.getLockDir()).to.equal(lockManager.getLockDir());
            expect(dynamicModuleLoader.getLockDir()).to.equal(path.join(tmpDir, "/locks"));

            dynamicModuleLoader.setLockDir('wibble');
            expect(dynamicModuleLoader.getLockDir()).to.equal(lockManager.getLockDir());
            expect(dynamicModuleLoader.getLockDir()).to.equal('wibble');

            dynamicModuleLoader.setLockDir('giblets');
            expect(dynamicModuleLoader.getLockDir()).to.equal(lockManager.getLockDir());
            expect(dynamicModuleLoader.getLockDir()).to.equal('giblets');

            done();
        });
    });

    describe('__downloadFile', function ()
    {
        it('should not find file', function (done)
        {
            var targetFile = tmpDir + "/file.tar.gz";
            var sourceUrl = "http://localhost/not-found.tar.gz";
            var result = dynamicModuleLoader.__downloadFile(sourceUrl, targetFile);
            var scope = nock("http://localhost").get("/not-found.tar.gz").reply(404);
            result.when(function (err, filePath)
                        {
                            expect(err, 'error object').to.not.equal(undefined);
                            expect(filePath, 'file path').to.equal(undefined);

                            expect(err.statusCode, 'error status code').to.equal(404);
                            expect(err.message, 'error message').to.equal("Unable to download from " + sourceUrl + " to " +
                                                                              targetFile + ".  Status code 404.");
                            expect(fs.existsSync(targetFile), 'target file existence').to.equal(false);

                            scope.done();
                            done();
                        });
        });

        it('should get an error because of unknown host', function (done)
        {
            var targetFile = tmpDir + "/file.tar.gz";
            var sourceUrl = "http://unknown-host/not-found.tar.gz";
            var result = dynamicModuleLoader.__downloadFile(sourceUrl, targetFile);
            result.when(function (err, filePath)
                        {
                            expect(err, 'error object').to.not.equal(undefined);
                            expect(filePath, 'file path').to.equal(undefined);

                            expect(err.statusCode, 'error status code').to.equal(undefined);
                            expect(err.message, 'error message').to.equal("getaddrinfo ENOENT");
                            expect(fs.existsSync(targetFile), 'target file existence').to.equal(false);

                            done();
                        });
        });

        it('should download file to temp directory', function (done)
        {
            var host = "http://gattacus";
            var path = "/test_dynamic_module.tar.gz";
            var sourceUrl = host + path;
            var scope = nock(host).get(path).replyWithFile(200, dynamicModuleTarGzipFilePath);
            var targetFile = tmpDir + "/downloaded.tar.gz";
            var result = dynamicModuleLoader.__downloadFile(sourceUrl, targetFile);
            result.when(function (err, filePath)
                        {
                            expect(err, 'error object').to.equal(undefined);
                            expect(filePath, 'file path').to.equal(targetFile);
                            expect(fs.existsSync(targetFile), 'target file existence').to.equal(true);

                            scope.done();
                            done();
                        });
        });
    });


    describe('__decompressTarFile', function ()
    {
        it('should decompress the tar file', function (done)
        {
            var targetFilePath = tmpDir + "/uncompressed.tar";
            var result = dynamicModuleLoader.__decompressTarFile(dynamicModuleTarGzipFilePath, targetFilePath);
            result.when(function (err, decompressedFilePath)
                        {
                            expect(err).to.equal(undefined);
                            expect(decompressedFilePath).to.equal(targetFilePath);
                            expect(fs.existsSync(targetFilePath), 'target file existence').to.equal(true);

                            done();
                        });
        });

        it('should fail to find the source tar file', function (done)
        {
            var targetFilePath = tmpDir + "/uncompressed.tar";
            var result = dynamicModuleLoader.__decompressTarFile("does-not-exist.tar.gz", targetFilePath);
            result.when(function (err, decompressedFilePath)
                        {
                            expect(err).to.not.equal(undefined);
                            expect(decompressedFilePath).to.equal(undefined);
                            expect(fs.existsSync(targetFilePath), 'target file existence').to.equal(false);

                            done();
                        });
        });

        it('should fail to write the target file', function (done)
        {
            var targetFilePath = tmpDir + "/some-non-existent-dir/should-not-work.tar";
            var result = dynamicModuleLoader.__decompressTarFile(dynamicModuleTarGzipFilePath, targetFilePath);
            result.when(function (err, decompressedFilePath)
                        {
                            expect(err).to.not.equal(undefined);
                            expect(decompressedFilePath).to.equal(undefined);
                            expect(fs.existsSync(targetFilePath), 'target file existence').to.equal(false);

                            done();
                        });
        });
    });


    describe('__decompressZipFile', function ()
    {
        it('should decompress the zip file', function (done)
        {
            var targetFilePath = path.join(dynamicModuleLoader.getModuleInstallationDir(), dynamicModuleName);
            var result = dynamicModuleLoader.__decompressZipFile(dynamicModuleZipFilePath,
                                                                 dynamicModuleLoader.getModuleInstallationDir());
            result.when(function (err, decompressedFilePath)
                        {
                            expect(err).to.equal(undefined);
                            expect(decompressedFilePath).to.equal(dynamicModuleLoader.getModuleInstallationDir());
                            expect(fs.existsSync(targetFilePath), 'target file existence').to.equal(true);

                            done();
                        });
        });

        it('should fail to find the source zip file', function (done)
        {
            var targetFilePath = path.join(tmpDir, "unzipped");
            var result = dynamicModuleLoader.__decompressZipFile("does-not-exist.zip",
                                                                 dynamicModuleLoader.getModuleInstallationDir());
            result.when(function (err, decompressedFilePath)
                        {
                            expect(err).to.not.equal(undefined);
                            expect(decompressedFilePath).to.equal(undefined);
                            expect(fs.existsSync(targetFilePath), 'target file existence').to.equal(false);

                            done();
                        });
        });
    });


    describe('__findPackageJSONFile', function ()
    {
        it('should find package.json in root dir', function (done)
        {
            dynamicModuleLoader.__findPackageJSONFile(dynamicModuleResourceDir)
                .when(function (err, packageJSONFilePath)
                      {
                          checkCorrectFileFound(err, packageJSONFilePath, done);
                      });
        });

        it('should find package.json in sub dir', function (done)
        {
            dynamicModuleLoader.__findPackageJSONFile(resourceDir)
                .when(function (err, packageJSONFilePath)
                      {
                          checkCorrectFileFound(err, packageJSONFilePath, done);
                      });
        });

        it('should find package.json in sub sub dir', function (done)
        {
            dynamicModuleLoader.__findPackageJSONFile(__dirname)
                .when(function (err, packageJSONFilePath)
                      {
                          checkCorrectFileFound(err, packageJSONFilePath, done);
                      });
        });

        it('should return the first package.json file found', function (done)
        {
            var targetDir = path.join(tmpDir, 'resources');
            wrench.copyDirSyncRecursive(resourceDir, targetDir);
            fs.writeFileSync(path.join(targetDir, 'test-dynamic-module/lib/package.json'), 'wibble', 'UTF-8');

            // Make sure we also have two package.json files with path names that are the same length, just to test
            // that it doesn't break anything.
            var bilDir = path.join(targetDir, 'test-dynamic-module/bil');
            wrench.mkdirSyncRecursive(bilDir);
            fs.writeFileSync(path.join(bilDir, 'package.json'), 'elbbiw', 'UTF-8');

            dynamicModuleLoader.__findPackageJSONFile(targetDir)
                .when(function (err, packageJSONFilePath)
                      {
                          checkCorrectFileFound(err, packageJSONFilePath, path.join(targetDir, 'test-dynamic-module/package.json'), done);
                      });
        });

        it('should not find anything and return an error', function (done)
        {
            var targetDir = path.join(tmpDir, 'resources');
            wrench.copyDirSyncRecursive(resourceDir, targetDir);
            fs.unlinkSync(path.join(targetDir, 'test-dynamic-module/package.json'));

            dynamicModuleLoader.__findPackageJSONFile(targetDir)
                .when(function (err, packageJSONFilePath)
                      {
                          expect(err, 'error').to.not.equal(undefined);
                          expect(packageJSONFilePath, 'package json file path').to.equal(undefined);
                          expect(err.message, 'error message').to.equal('Unable to find package.json file in directory ' + targetDir + ' or any of its sub directories.');

                          done();
                      });
        });

        function checkCorrectFileFound(err, actualPackageJSONFilePath, expectedPackageJSONFilePath, done)
        {
            if (expectedPackageJSONFilePath instanceof Function)
            {
                done = expectedPackageJSONFilePath;
                expectedPackageJSONFilePath = path.join(dynamicModuleResourceDir, 'package.json');
            }

            expect(err, 'error').to.equal(undefined);
            expect(actualPackageJSONFilePath, 'package json file path').to.not.equal(undefined);
            expect(path.resolve(actualPackageJSONFilePath), 'package json file path').to.equal(expectedPackageJSONFilePath);

            done();
        }
    });


    describe('load', function ()
    {
        it('should download, uncompress and return a valid module from a .tar.gz source', function (done)
        {
            runTest(expectDownloadRequest, '/test-dynamic-module.tar.gz', dynamicModuleTarGzipFilePath, undefined, true, undefined, expectModuleInstallationDirRename, done)
        });

        it('should download, uncompress and return a valid module from a zip source with embedded root dir', function (done)
        {
            // Override the default extension to be .zip.
            dynamicModuleLoader.setDefaultRemoteServerPackageFileExtension('.zip');

            // Now request a .tar.gz module specifying the extension explicitly in the load call.
            runTest(expectDownloadRequest, '/test-dynamic-module.zip', dynamicModuleZipFilePath, undefined, true, undefined, expectModuleInstallationDirRename, done);
        });

        it('should download, uncompress and return a valid module from a zip source with no embedded root dir - XXX', function (done)
        {
            // Override the default extension to be .zip.
            dynamicModuleLoader.setDefaultRemoteServerPackageFileExtension('.zip');

            // Now request a .tar.gz module specifying the extension explicitly in the load call.
            runTest(expectDownloadRequest, '/test-dynamic-module-no-root-dir.zip', dynamicModuleZipFileNoRootDirPath, undefined, true, undefined, expectModuleInstallationDirRename, done);
        });

        it('should download, uncompress and return a valid module from a .tar.gz source when an overriding extension is specified', function (done)
        {
            // Override the default extension to be .zip.
            dynamicModuleLoader.setDefaultRemoteServerPackageFileExtension('.zip');

            // Now request a .tar.gz module specifying the extension explicitly in the load call.
            runTest(expectDownloadRequest, '/test-dynamic-module.tar.gz', dynamicModuleTarGzipFilePath, ".tar.gz", true, undefined, expectModuleInstallationDirRename, done);
        });

        it('should download, uncompress and return a valid module from a .zip source when an overriding extension is specified', function (done)
        {
            // Override the default extension to be .tar.gz.
            dynamicModuleLoader.setDefaultRemoteServerPackageFileExtension('.tar.gz');

            // Now request a .zip module specifying the extension explicitly in the load call.
            runTest(expectDownloadRequest, '/test-dynamic-module.zip', dynamicModuleZipFilePath, '.zip', true, undefined, doNotExpectModuleInstallationDirRename, done);
        });

        it('should download module when no listeners registered', function (done)
        {
            runTest(expectDownloadRequest, '/test-dynamic-module.tar.gz', dynamicModuleTarGzipFilePath, undefined, false, undefined, doNotExpectModuleInstallationDirRename, done);
        });

        it('should skip npm installation', function (done)
        {
            dynamicModuleLoader.setNpmSkipInstall(true);
            runTest(expectDownloadRequest, '/test-dynamic-module.tar.gz', dynamicModuleTarGzipFilePath, undefined, false, undefined, doNotExpectModuleInstallationDirRename, ensureNodeModulesDirectoryNotPresent);

            function ensureNodeModulesDirectoryNotPresent()
            {
                // We make sure that there is no "node_modules" directory in the expanded package.  If there is one it
                // means that the NPM program was invoked, which is exactly what we want to avoid.
                expect(fs.existsSync(path.join(dynamicModuleFilePath, '/node_modules'), 'node_modules directory exists')).to.equal(false);
                done();
            }
        });

        it('should stop download with error when moduleDownloaded event listener reports an error', function (done)
        {
            // Register the event listener that will halt proceedings.
            dynamicModuleLoader.on(dynamicModuleLoader.events.moduleDownloaded, function (moduleName, downloadedFile, proceed)
            {
                proceed(new Error('moduleDownloaded halt!'));
            });

            // These event handlers are called later in the workflow, so they should have no effect as processing should
            // have halted as a result of the above event.  We register them to make sure that the correct handler is
            // halting things.
            dynamicModuleLoader.on(dynamicModuleLoader.events.moduleExtracted, function (moduleName, downloadedFile, proceed)
            {
                proceed(new Error('moduleExtracted halt!'));
            });
            dynamicModuleLoader.on(dynamicModuleLoader.events.moduleInstalled, function (moduleName, downloadedFile, proceed)
            {
                proceed(new Error('moduleInstalled halt!'));
            });
            dynamicModuleLoader.on(dynamicModuleLoader.events.moduleLoaded, function (moduleName, downloadedFile, proceed)
            {
                proceed(new Error('moduleLoaded halt!'));
            });

            runTest(expectDownloadRequest, '/test-dynamic-module.tar.gz', dynamicModuleTarGzipFilePath, undefined, true, 'moduleDownloaded halt!', doNotExpectModuleInstallationDirToBePresent, done)
        });

        it('should stop download with error when moduleExtracted event listener reports an error', function (done)
        {
            // Register the event listener that will halt proceedings.
            dynamicModuleLoader.on(dynamicModuleLoader.events.moduleExtracted, function (moduleName, downloadedFile, proceed)
            {
                proceed(new Error('moduleExtracted halt!'));
            });

            // These event handlers are called later in the workflow, so they should have no effect as processing should
            // have halted as a result of the above event.  We register them to make sure that the correct handler is
            // halting things.
            dynamicModuleLoader.on(dynamicModuleLoader.events.moduleInstalled, function (moduleName, downloadedFile, proceed)
            {
                proceed(new Error('moduleInstalled halt!'));
            });
            dynamicModuleLoader.on(dynamicModuleLoader.events.moduleLoaded, function (moduleName, downloadedFile, proceed)
            {
                proceed(new Error('moduleLoaded halt!'));
            });

            runTest(expectDownloadRequest, '/test-dynamic-module.tar.gz', dynamicModuleTarGzipFilePath, undefined, true, 'moduleExtracted halt!', expectModuleInstallationDirRename, done)
        });

        it('should stop download with error when moduleInstalled event listener reports an error', function (done)
        {
            // Register the event listener that will halt proceedings.
            dynamicModuleLoader.on(dynamicModuleLoader.events.moduleInstalled, function (moduleName, downloadedFile, proceed)
            {
                proceed(new Error('moduleInstalled halt!'));
            });

            // These event handlers are called later in the workflow, so they should have no effect as processing should
            // have halted as a result of the above event.  We register them to make sure that the correct handler is
            // halting things.
            dynamicModuleLoader.on(dynamicModuleLoader.events.moduleLoaded, function (moduleName, downloadedFile, proceed)
            {
                proceed(new Error('moduleLoaded halt!'));
            });

            runTest(expectDownloadRequest, '/test-dynamic-module.tar.gz', dynamicModuleTarGzipFilePath, undefined, true, 'moduleInstalled halt!', expectModuleInstallationDirRename, done)
        });

        it('should download stop with error when moduleLoaded event listener reports an error', function (done)
        {
            // Register the event listener that will halt proceedings.
            dynamicModuleLoader.on(dynamicModuleLoader.events.moduleLoaded, function (moduleName, proceed)
            {
                proceed(new Error('moduleLoaded halt!'));
            });

            runTest(expectDownloadRequest, '/test-dynamic-module.tar.gz', dynamicModuleTarGzipFilePath, undefined, true, 'moduleLoaded halt!', expectModuleInstallationDirRename, done)
        });

        it('should not download and extract a module if it is already extracted on the disk', function (done)
        {
            // Download a module and load it.
            runTest(expectDownloadRequest, '/test-dynamic-module.zip', dynamicModuleZipFilePath, '.zip', true, undefined, doNotExpectModuleInstallationDirRename, runSecondTest);

            function runSecondTest()
            {
                // Now "unload" it from the cache.
                dynamicModuleLoader.downloadedModuleMainFileCache = {};

                // To test, we register event listeners that will cause an error when events are fired we don't expect.
                // In this test, we expect that only the "module loaded" event will be fired.  If we get anything else then
                // there's a problem.
                dynamicModuleLoader.on(dynamicModuleLoader.events.moduleDownloaded, function (moduleName, downloadedFile, proceed)
                {
                    proceed(new Error('moduleDownloaded event not expected'));
                });
                dynamicModuleLoader.on(dynamicModuleLoader.events.moduleExtracted, function (moduleName, downloadedFile, proceed)
                {
                    proceed(new Error('moduleExtracted event not expected'));
                });
                dynamicModuleLoader.on(dynamicModuleLoader.events.moduleInstalled, function (moduleName, downloadedFile, proceed)
                {
                    proceed(new Error('moduleInstalled event not expected'));
                });

                // We expect this listener to be called.
                var eventsCalled = {};
                dynamicModuleLoader.on(dynamicModuleLoader.events.moduleLoaded, function (moduleName, proceed)
                {
                    eventsCalled.moduleLoaded = true;
                    expect(moduleName, "moduleName").to.equal("test-dynamic-module");
                    proceed();
                });

                // Run the test again.
                runTest(doNotExpectDownloadRequest, '/test-dynamic-module.zip', dynamicModuleZipFilePath, '.zip', false, undefined, doNotExpectModuleInstallationDirRename, done)
            }
        });

        function doNotExpectDownloadRequest()
        {
            return { done:function ()
            {
            } };
        }

        function expectDownloadRequest(downloadTarget, packagePath)
        {
            return nock(dynamicModuleLoader.getModulePackageServerUrl())
                .get(downloadTarget)
                .replyWithFile(200, packagePath);
        }

        function doNotExpectModuleInstallationDirToBePresent(targetModuleName)
        {
            var fileNames = fs.readdirSync(dynamicModuleLoader.getModuleInstallationDir());
            expect(fileNames.length, 'installation dir').to.equal(0);
        }

        function doNotExpectModuleInstallationDirRename(targetModuleName)
        {
            var fileNames = fs.readdirSync(dynamicModuleLoader.getModuleInstallationDir());
            expect(fileNames.length, 'installation dir').to.equal(1);
            expect(fileNames[0], 'installation dir name ').to.equal(targetModuleName);
        }

        function expectModuleInstallationDirRename(targetModuleName)
        {
            var fileNames = fs.readdirSync(dynamicModuleLoader.getModuleInstallationDir());
            expect(fileNames.length, 'renamed installation dir').to.equal(1);
            expect(_.str.startsWith(fileNames[0], targetModuleName + "-ERROR-"),
                   'renamed installation dir name was ' + fileNames[0])
                .to.equal(true);
        }

        function runTest(expectDownloadRequest, expectedDownloadTarget, targetModulePackagePath, explicitLoadMethodExtension, shouldRegisterListeners, expectedErrorMessage, expectModuleInstallationDirRename, done)
        {
            // Mock out the call to retrieve the binary and return the one we packaged up in the setup method.
            var scope = expectDownloadRequest(expectedDownloadTarget, targetModulePackagePath);

            var compressedFileName = expectedDownloadTarget.substring(1);
            var targetModuleName = compressedFileName.replace(".zip", "").replace(".tar.gz", "");

            // Set up event listeners to test that events are fired correctly.
            var eventsCalled = {};
            if (shouldRegisterListeners)
            {
                dynamicModuleLoader.on(dynamicModuleLoader.events.moduleDownloaded, function (moduleName, downloadedFile, proceed)
                {
                    eventsCalled.moduleDownloaded = true;
                    expect(moduleName, "moduleName").to.equal(targetModuleName);
                    expect(downloadedFile, "downloadedFile").to.equal(path.join(dynamicModuleLoader.getDownloadDir(), compressedFileName));

                    assertModuleLockStatus(true);

                    proceed();
                });
                dynamicModuleLoader.on(dynamicModuleLoader.events.moduleExtracted, function (moduleName, extractLocation, proceed)
                {
                    eventsCalled.moduleExtracted = true;
                    expect(moduleName, "moduleName").to.equal(targetModuleName);

                    assertModuleLockStatus(true);

                    proceed();
                });
                dynamicModuleLoader.on(dynamicModuleLoader.events.moduleInstalled, function (moduleName, installationLocation, proceed)
                {
                    eventsCalled.moduleInstalled = true;
                    expect(moduleName, "moduleName").to.equal(targetModuleName);

                    var expectedLocation1 = path.join(dynamicModuleLoader.getModuleInstallationDir(), targetModuleName);
                    var expectedLocation2 = path.join(expectedLocation1, targetModuleName);

                    expect(installationLocation === expectedLocation1 || installationLocation === expectedLocation2,
                           "installationLocation")
                        .to.equal(true);

                    assertModuleLockStatus(true);

                    proceed();
                });
                dynamicModuleLoader.on(dynamicModuleLoader.events.moduleLoaded, function (moduleName, proceed)
                {
                    eventsCalled.moduleLoaded = true;
                    expect(moduleName, "moduleName").to.equal(targetModuleName);

                    assertModuleLockStatus(true);

                    proceed();
                });
            }

            // Now kick off the module.
            var downloadedModule;
            var result = dynamicModuleLoader.load(targetModuleName, explicitLoadMethodExtension);
            result.when(function (err, module)
                        {
                            scope.done();

                            if (expectedErrorMessage)
                            {
                                // We expect an error.  Make sure it's the right one.
                                expect(err.message, 'error message').to.equal(expectedErrorMessage);

                                // Make sure we have a renamed module installation directory.
                                expectModuleInstallationDirRename(targetModuleName);

                                done();
                            }
                            else
                            {
                                // No error expected.  Make sure everything functioned correctly.
                                expect(err, 'error object').to.equal(undefined);
                                expect(module, 'dynamically loaded module').to.not.equal(undefined);

                                expect(module.name, 'module name').to.equal("This Is My Name");

                                var future = module.hello();
                                expect(future, 'dynamic module future').to.not.equal(undefined);

                                future.when(function (err, result)
                                            {
                                                expect(err, 'dynamic module error object').to.equal(undefined);
                                                expect(result, 'result of dynamic module future call').to.equal("hello world");

                                                downloadedModule = module;

                                                loadAgain();
                                            });
                            }
                        });

            function loadAgain()
            {
                // Now we load the same module again.  We should get the same result back as before (the exact same
                // module) but this time we shouldn't be downloading it.  We should get it from the previously-downloaded
                // cache.
                result = dynamicModuleLoader.load(targetModuleName, explicitLoadMethodExtension);
                result.when(function (err, module)
                            {
                                expect(err, 'error object').to.equal(undefined);
                                expect(module).to.equal(downloadedModule);

                                assertEventsCalled();
                            });
            }

            function assertEventsCalled()
            {
                if (shouldRegisterListeners)
                {
                    expect(eventsCalled.moduleDownloaded, "moduleDownloaded event called").to.equal(true);
                    expect(eventsCalled.moduleExtracted, "moduleExtracted event called").to.equal(true);
                    expect(eventsCalled.moduleInstalled, "moduleInstalled event called").to.equal(true);
                    expect(eventsCalled.moduleLoaded, "moduleLoaded event called").to.equal(true);
                }

                assertModuleLockStatus(false);
                done();
            }

            function assertModuleLockStatus(expectedStatus)
            {
                // Module should be locked at this point.
                expect(fs.existsSync(path.join(lockManager.getLockDir(), targetModuleName + '.lock')), 'lock file').to.equal(expectedStatus);
            }
        }
    });
});
