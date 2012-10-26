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
var path = require('path');

function createDefault() {
    return {
        npmExecutablePath: '/usr/local/bin/npm',
        npmInstallVerbose: false,
        downloadDir: path.normalize('./downloads'),
        moduleInstallationDir: path.normalize('./installed-modules'),
        modulePackageServerUrl: 'http://localhost',
        downloadLockTimeout: 30000,
        defaultRemoteServerPackageFileExtension: ".tar.gz",
        unzipExecutablePath: '/usr/bin/unzip',
        npmSkipInstall: false,
        lockDir: path.normalize('./locks'),
        lockOwner: 'DynamicModuleLoader'
    };
}

module.exports.createDefaultConfig = createDefault();
