/*
 * Copyright 2012 VirtuOz Inc. All rights reserved.
 */
// We always want long stack traces here.
require('longjohn');

var path = require('path');
var assert = require('chai').assert;

var dmlConfig = require('../index').config;

describe('DynamicModuleLoaderConfigTest', function ()
{
    describe('createDefault', function ()
    {
        it('should create a valid default configuration object', function (done)
        {
            var config = dmlConfig.createDefaultConfig();

            assert.equal(config.npmExecutablePath, '/usr/local/bin/npm', 'npmExecutablePath');
            assert.deepEqual(config.npmOptions, ['--production'], 'npmOptions');
            assert.equal(config.downloadDir, path.normalize('./downloads'), 'downloadDir');
            assert.equal(config.moduleInstallationDir, path.normalize('./installed-modules'), 'moduleInstallationDir');
            assert.equal(config.modulePackageServerUrl, 'http://localhost', 'modulePackageServerUrl');
            assert.equal(config.downloadLockTimeout, 30000, 'downloadLockTimeout');
            assert.equal(config.defaultRemoteServerPackageFileExtension, '.tar.gz', 'defaultRemoteServerPackageFileExtension');
            assert.equal(config.unzipExecutablePath, '/usr/bin/unzip', 'unzipExecutablePath', 'npmSkipInstall');
            assert.equal(config.cleanUpEnabled, false);
            assert.equal(config.cleanUpExecutablePath, '');
            assert.equal(config.cleanUpScriptArguments, '');
            assert.equal(config.npmSkipInstall, false);
            assert.deepEqual(config.lockOwner, {id:'DynamicModuleLoader'}, 'lockOwner');

            done();
        });
    });
});