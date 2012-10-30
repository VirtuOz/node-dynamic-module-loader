/*
 * Copyright 2012 VirtuOz Inc.  All rights reserved.
 */

/**
 * test_dynamic_module
 *
 * @author Kevan Dunsmore
 * @created 2012/08/27
 */
var Future = require('futures').future;

module.exports = function()
{
    var future = new Future();

    // No need to bother with anything fancy.  We can pre-fulfill this future with a success message.  The point is
    // only to include NPM dependencies in our test dynamic module to make sure everything works.
    future.fulfill(undefined, "hello world");

    return future;
};