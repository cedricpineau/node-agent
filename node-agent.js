#!/usr/bin/env node

var request = require ('request')
  , winston = require('winston')
  , os = require('os')
  , fs = require('fs')
  , util = require('util')
  , AdmZip = require('adm-zip')
  , optimist = require('optimist')
  , Seq = require('seq')
  , fsextra = require('fs.extra')
  , spawn = require('child_process').spawn;

var logger = new (winston.Logger)({
    transports: [
      new (winston.transports.Console)()
    ]
});
process.on('uncaughtException', function(err) {
  logger.error(err);
});

var TMP = os.tmpdir()+'/';
var TMP_STREAM_PREFIX = 'tmp_';
var AGENT_ARCHIVE = 'agent.zip';
var AGENT_CONFIG = 'config.js';
var AGENT_INSTALLATION = '/tmp/agent/';
var DEFAULT_URL = 'http://localhost:3000'; // 'http://node-agent-server';
var DEFAULT_DELAY = 5; // 60;

var argv = optimist
  .usage(['Start node-agent-boostrap.',
    ' Usage: $0 --url [url] --delay [delay]'].join('\n'))
  .option('url', {
    description: 'agent server. Defaults to ' + DEFAULT_URL,
    default: DEFAULT_URL
  }).option('delay', {
    description: 'agent update delay in seconds; Defaults to ' + DEFAULT_DELAY,
    default: DEFAULT_DELAY
  })
  .argv;


var config = { 
	url : argv.url
      , delay : argv.delay
    };

function copyFile(source, target, cb) {
  var cbCalled = false;

  var rd = fs.createReadStream(source);
  rd.on("error", function(err) {
    done(err);
  });
  var wr = fs.createWriteStream(target);
  wr.on("error", function(err) {
    done(err);
  });
  wr.on("close", function(ex) {
    done();
  });
  rd.pipe(wr);

  function done(err) {
    if (!cbCalled) {
      cb(err);
      cbCalled = true;
    }
  }
}

function downloadIfChanged (file, url, currentVersion, cb){
  var headers = {};
  if(currentVersion){
    headers['If-None-Match'] = currentVersion;
  }
  var newVersion;

  var tmpStream = TMP+TMP_STREAM_PREFIX+file
  var stream = fs.createWriteStream(tmpStream);
  stream.once('close', function(){
  Seq().seq(function () {
      fs.unlink(TMP+file, function(err) { })
      this()
    }).seq(function () {
      fsextra.move(tmpStream, TMP+file, this);
    }).seq(function () {
      cb(null, newVersion);
    }).catch(function (err) {
	cb(err);
    })
  });

  request({'url':url, 'headers':headers}, function (err, res) {
    if (!err && res.statusCode === 200) {
      newVersion = res.headers.etag;
    } else{
      stream.removeAllListeners('close');
      if (res.statusCode === 304) { // Not Modified
	cb(null, currentVersion);
      } else {
        cb(err || new Error('Retrieving remote configuration : ' + res.statusCode));
      }
    }
  }).pipe(stream);
  return;
}

function installAgent(cb){
  logger.info('Installing agent.');

  Seq().seq(function () {
      fsextra.rmrf(AGENT_INSTALLATION, this)
    }).seq(function () {
      new AdmZip(TMP+AGENT_ARCHIVE).extractAllTo(AGENT_INSTALLATION)
      this()
    }).seq(function () {
      copyFile(TMP+AGENT_CONFIG, AGENT_INSTALLATION+AGENT_CONFIG, this)
    }).seq(function () {
      cb();
    }).catch(function (err) {
	cb(err);
    })
  
}

var agentProcess
function startAgent(cb){
  logger.info('Starting agent.');
  agentProcess = spawn('node', [AGENT_INSTALLATION+'agent.js'])
  cb();
}

function stopAgent(cb){
  logger.info('Stopping running agent.');
  if (agentProcess) {
	agentProcess.kill('SIGHUP');
  }
  cb();
}

var currentAgentVersion;
var currentConfigVersion;
function updateAgent() {
  Seq().par(function () {
        downloadIfChanged(AGENT_ARCHIVE, config.url+'/agent/agent.zip', currentAgentVersion, this);
    }).par(function () {
        downloadIfChanged(AGENT_CONFIG, config.url+'/agent/config.js', currentConfigVersion, this);
    }).seq(function (newAgentVersion, newConfigVersion) {
	if (newAgentVersion !== currentAgentVersion || newConfigVersion !== currentConfigVersion) {
		this();
	}
    }).seq(function () {
	stopAgent(this);
    }).seq(function () {
	installAgent(this);
    }).seq(function () {
	startAgent(this);
    }).seq(function () {
	currentAgentVersion = this.args[0];
	currentConfigVersion = this.args[1];
    });
}

updateAgent();
var delay = config.delay * 1000;
setInterval(updateAgent, delay);
logger.info('reloading remote config every %d ms', delay);



