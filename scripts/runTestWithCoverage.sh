#!/bin/bash
rm -rf target
mkdir -p target
jscoverage lib target/lib-cov
XUNIT_HTML_COV_CONFIG=../../../xunit-html-cov-config.json TEST_COV_DIR=./target/lib-cov node_modules/mocha/bin/_mocha test/*_test.js --ignore-leaks -t 20000 --reporter xunit-html-cov
