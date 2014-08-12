dynamic-module-loader [![Build Status](https://travis-ci.org/VirtuOz/node-dynamic-module-loader.png)](https://travis-ci.org/VirtuOz/node-dynamic-module-loader)
=====================

The dynamic module loader library allows code to retrieve Node modules from a web server, install them locally and serve
them up as though they'd been manually deployed to the running server.  This allows you to retrieve content from remote
sources when necessary and manage updates dynamically.  Internally the dynamic module loader uses cluster-lock to
ensure that only one download request happens at any time for a single module.  In other words, if you have a cluster
on a single machine and multiple processes request the same module at the same time, only one will download and install
the module.  The others will wait until the process is complete before serving the module up from its local location.


The Packages
------------

Packages must adhere to the following structure:

    package-dir
    |
    +- package.json

The Javascript files in the package may live anywhere, in any directory.  You need only be able to _require_ them.
The rule is that you should follow the same rules for a dynamic module as you would for a Node.js library module.

The package.json file must contain the following:

    {
        "main":"<path to main module"
    }

If you use other Node.js libraries, you must include the standard NPM dependencies blocks.  The actual libraries shown
below are for illustrative purposes only; you can put whatever you want in the dependencies section, as long as they
can be accessed by the runtime server when NPM installs the package:

    {
        "main":"./index.js",

        "dependencies":{
            .
            .
            .
            underscore":"1.3.3",
            "futures":"2.1.0",
            "underscore.string":"2.2.0rc",
            "jsclass":"3.0.9",
            .
            .
            .
        }
    }


The Web Server
--------------

Packages may be served by the web server in _tar.gz_ or _zip_ form.  Zip packages may have the _package.json_ file at
the root level or in a directory stored at the root level.  So you can have a package called _my-package.zip_ with
either this internal structure:

    my-package
    |
    +- package.json
    +- main.js
    +- <whatever>

or with no root folder, like this:

    +- package.json
    +- main.js
    +- <whatever>

The _DynamicModuleLoader_ will find the location of the _package.json_ file and use that as the root of the module.

You need not pre-install the package using NPM.  In other words, you needn't include the __node_modules__ dependencies
in the package.

The _DynamicModuleLoader_ will make GET requests for packages using URLs of the form:

    http://the-server/module-name.tar.gz

Where _http://the-server_ is a configuration value and _module-name_ is the name of the module requested at runtime.


How To Use
----------

OK, enough blabbing.  Here's how you create and configure a DynamicModuleLoader:

    // Require all of the needful.
    var LockManager = require('hurt-locker').LockManager;
    var DynamicModuleLoader = require('dynamic-module-loader').DynamicModuleLoader;

    // Create our loader.
    var dynamicModuleLoader = new DynamicModuleLoader();

    // Configure the directories needed by the module loader.  These methods also have accessors (getXXDir()).

    // Set the download directory.  Default is ./downloads
    dynamicModuleLoader.setDownloadDir(path.normalize("/some/accessible/location/downloads"));

    // Set the installed modules directory.  Default is ./installed-modules
    dynamicModuleLoader.setModuleInstallationDir(path.normalize("/somewhere/else/accessible/installed-modules"));

    // Configure the package web sever URL.  URL can be anything.  Default is http://localhost.
    dynamicModuleLoader.setModulePackageServerUrl("http://gattacus");

    // Provide the loader with a lock manager.  If you don't do this it will create its own lock manager and use
    // ./locks as the lock directory.
    var lockManager = new LockManager();
    lockManager.setLockDir(path.normalize("/another/accessible/location/for/lock/files");
    dynamicModuleLoader.setLockManager(lockManager);

Now that it's been configured we can download and run some packages.  But not so fast big boy!  Hold your horses!  We need
a package first.

Let's say we have a package that consists of just two files: the _package.json_ file and the main package file.  To make
it interesting, the package uses Futures.  Here are the files in the package:

*package.json*

    {
        "name":"test-dynamic-module",
        "version":"0.0.1",
        "main":"./index.js",
        "dependencies":{
            "futures":"2.1.0"
        }
    }

*index.js*

    var Future = require('futures').future;

    module.exports.helloWorld = function()
    {
        var future = new Future();

        // No need to bother with anything fancy.  We can pre-fulfill this future with a success message.  The point is
        // only to include NPM dependencies in our test dynamic module to make sure everything works.
        future.fulfill(undefined, "hello world");

        return future;
    };

We can call the _helloWorld_ function like this:

    var moduleResult = dynamicModuleLoader.load('test-dynamic-module');
    result.when(function(err, module)
                {
                    if (err)
                    {
                        // Failed to download the module.  You can try again or give up like a sissi.
                        return;
                    }


                    // Do something with the module.
                    console.log(module.helloWorld());
                });

Changing Defaults
-----------------

By default the _DynamicModuleLoader_ assumes you will be downloading packages in _tar.gz_ form.  You can change the
default like this:

    var dynamicModuleLoader = new DynamicModuleLoader();
    dynamicModuleLoader.setDefaultRemoteServerPackageFileExtension('.zip');

    // Will assume a .zip extension when requesting the package from the web server.
    var moduleResult = dynamicModuleLoader.load('test-dynamic-module');
    .
    .
    .

You can always override the default by specifying the extension when calling _load_:

    // By default assume .tar.gz.
    var dynamicModuleLoader = new DynamicModuleLoader();

    // Will assume a .tar.gz extension when requesting the package from the web server.
    var moduleResult = dynamicModuleLoader.load('test-dynamic-module');
    .
    .
    .

    // Will assume a .zip extension when requesting the package from the web server.
    var moduleResult = dynamicModuleLoader.load('test-dynamic-module', '.zip');
    .
    .
    .


External Dependencies
---------------------

_DynamicModuleLoader_ depends on the existence of _npm_ and _unzip_ on the machine on which it is deployed.  You can
specify the paths to these executables like this:

    var dynamicModuleLoader = new DynamicModuleLoader();
    dynamicModuleLoader.setNpmExecutablePath('/wherever/npm/is/installed');
    dynamicModuleLoader.setUnzipExecutablePath('/wherever/unzip/ins/installed');

By default, _DynamicModuleLoader_ assumes that _npm_ and _unzip_ paths are _/usr/local/bin/npm_ and _usr/bin/unzip_
respectively.


Customizing NPM Options
-----------------------

You can customize the NPM options.  For example, you can set NPM to perform a verbose install:

    var dynamicModuleLoader = new DynamicModuleLoader({
        npmOptions: ['--production', '--verbose']
    });
    dynamicModuleLoader.setNpmInstallVerbose(true);


Skipping Installation
---------------------

You can configure the dynamic downloader such that it doesn't execute the 'npm install' phase.  In this configuration,
the downloader assumes that modules have been pre-installed and that executing npm is not necessary.  The loader still
fires the same events in this configuration but you need not specify the location of NPM.  Here's how to skip the
installation process:

    dynamicModuleLoader.setNpmSkipInstall(true);

You can get the configuration settings like this:

    dynamicModuleLoader.getNpmSkipInstall();

By default, NPM install is turned <b>on</b>, meaning that the "NPMSkipInstall" property is false.


Events
------

_DynamicModuleLoader_ is an event emitter.  Here's how to listen for the events it fires:

    var dynamicModuleLoader = new DynamicModuleLoader();
    dynamicModuleLoader.on(dynamicModuleLoader.events.moduleDownloaded, function(moduleName, downloadedFile, next)
    {
        // Called when a module is downloaded from a remote source.

        // moduleName - The name of the module downloaded.
        // downloadedFile - The package file that was downloaded.
        // next - A function that proceeds to the next stage in the event workflow (see below).
    });
    dynamicModuleLoader.on(dynamicModuleLoader.events.moduleExtracted, function(moduleName, extractLocation, next)
    {
        // Called after a module has been downloaded and the package has been extracted to disk.

        // moduleName - The name of the module extracted.
        // extractLocation - The location to which the package contents were extracted.
        // next - A function that proceeds to the next stage in the event workflow (see below).
    });
    dynamicModuleLoader.on(dynamicModuleLoader.events.moduleInstalled, function(moduleName, installationLocation, next)
    {
        // Called after a module has been extracted and NPM has installed it.

        // moduleName - The name of the module installed.
        // extractLocation - The location to which the package contents were extracted.
        // next - A function that proceeds to the next stage in the event workflow (see below).
    });
    dynamicModuleLoader.on(dynamicModuleLoader.events.moduleLoaded, function(moduleName, next)
    {
        // Called after a module has been NPM installed and loaded.

        // moduleName - The name of the module loaded.
        // next - A function that proceeds to the next stage in the event workflow (see below).
    });
    dynamicModuleLoader.on(dynamicModuleLoader.events.moduleEvicted, function(moduleName)
    {
        // Called whenever a module has been evicted from memory

        // moduleName - The name of the module evicted.
    });
    dynamicModuleLoader.on(dynamicModuleLoader.events.moduleDestroyed, function(moduleName)
    {
        // Called after the system has called the destroy method of the module (just before the eviction)

        // moduleName - The name of the module loaded.
    });

Next Function
-------------

The "next" function passed to event methods is a counted callback.  That means that processing will continue when *all*
event listeners call "next".  If one of the listeners fails to call it, processing will stall, so be sure you invoke
next()!

The next function takes the following parameters:

- err An error object.  Pass 'undefined' if there was no error.
- all other parameters.

Evict Function
--------------

The `evict` function that takes a package name (same one provided during the load) in parameter will evict this module
from the cache. It means that if you're doing another dynamicLoader.load of this package, the system will have to
reload the package from the disk instead of using the require.cache. It can be very useful for when you need to load
lot or big packages and do not use them for long.

The `evict` function returns a `future` object (same kind as the `load` function) so you can add a callback to it using
the function `when` on the `future` object. See example below :

```javascript

    var moduleResult = dynamicModuleLoader.load('test-dynamic-module');

    //Do some processing

    dynamicModuleLoader.evict('test-dynamic-module').when(function (err, packageName) {
        //Package 'packageName' correctly evicted from the cache if there is no 'err'
    });

```

One particularity of this evict function is that it will try to call a function 'destroy(callback)' of your module so you can
on cleanup any resource you want to cleanup (especially useful when using c++ native library). Here is an example of how
it work :

You need to export inside your module a function named `destroy` which takes 1 argument, the callback function :

```javascript
module.exports.destroy = function(callback) {
 //Implement what you want to do just before the module is evicted
 callback(); //This function call is mandatory as it allows the system to know when you're done and continue with the eviction
}
```

If the module doesn't contains a function named `destroy` then the eviction of the module will be done directly.

Logging
-------

By default, the _DynamicModuleLoader_ will create a new Winston instance, but you can set the logger you want to use instead:
```javascript
  var dynamicModuleLoader = new DynamicModuleLoader(undefined, require('winston'));
```
This will permit you to use for example the same winston instance than your app is already using, or even to use
an other logger than winston. The only constrain is that the object you pass in paramater has the
`info()`, `debug()` and `error()` functions defined.


All Properties and Defaults
---------------------------

Here are the properties published by _DynamicModuleLoader_ along with their respective default values:

Property Name                              | Default Value
-------------------------------------------|------------------------------------------------------------------------
downloadDir                                | path.normalize('./downloads')
moduleInstallationDir                      | path.normalize('./installed-modules')
modulePackageServerUrl                     | http://localhost
npmExecutablePath                          | /usr/local/bin/npm
npmOptions                                 | An array of options supplied to npm.  By default contains ['--production']. See NPM options https://npmjs.org/doc/.
npmSkipInstall                             | false
lockManager                                | new lock manager, lock dir set to path.normalize('./locks')
downloadLockTimeout                        | 30000
lockOwner                                  | {id:'DynamicModuleLoader'}
defaultRemoteServerPackageFileExtension    | .tar.gz
unzipExecutablePath                        | /usr/bin/unzip
