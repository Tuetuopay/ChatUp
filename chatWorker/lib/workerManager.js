"use strict";
var got = require('got');
var debug = require('debug')('ChatUp:ChatWorker:master');
var uuid = require('node-uuid');
var url = require('url');
var _ = require('lodash');
var redis = require('redis');
var superagent = require('superagent');
var logger = require('../../common/logger');
exports.registerWorker = function (worker) {
    var redisConnection = redis.createClient(worker._conf.redis.port, worker._conf.redis.host);
    return validateWorkerInfos(worker).then(function () {
        startWSHandlersMonitoring(worker);
    }).then(function () {
        startAlivePing(worker, redisConnection);
    });
};
function getNginxStats(worker) {
    return new Promise(function (resolve, reject) {
        superagent.get('http://127.0.0.1:' + worker._conf.nginx.port + '/channels-stats?id=ALL')
            .end(function (err, res) {
            if (err) {
                logger.captureError(logger.error('Error while getting nginx stats', { err: err }));
                debug('Error while getting nginx stats', err);
                return reject(err);
            }
            try {
                var rawStats = JSON.parse(res.text);
                var channelsStats = _.reduce(rawStats.infos, function (stats, info) {
                    var channelName = info.channel;
                    if (_.startsWith(info.channel, 'm_')) {
                        channelName = channelName.slice(2);
                    }
                    else if (_.startsWith(info.channel, 'e_')) {
                        return stats;
                    }
                    if (Number(info.subscribers) > 0) {
                        stats[channelName] = Number(info.subscribers);
                    }
                    return stats;
                }, {});
            }
            catch (err) {
                logger.captureError(logger.error('Error while parsing nginx stats', { err: err }));
                debug('Error while parsing nginx stats', err);
                return reject(err);
            }
            resolve(channelsStats);
        });
    });
}
function validateWorkerInfos(worker) {
    return new Promise(function (resolve, reject) {
        if (!worker._conf.uuid) {
            worker._conf.uuid = uuid.v4();
        }
        if (worker._conf.hostname) {
            return resolve();
        }
        got('https://api.ipify.org', function (err, ip) {
            if (err) {
                logger.captureError(logger.error('Couldn\'t get worker ip address', { err: err }));
                return reject(new Error("Couldn't get worker ip address"));
            }
            worker._conf.hostname = ip;
            resolve();
        });
    }).then(function () {
        worker._conf.host = url.format({
            hostname: worker._conf.hostname,
            protocol: worker._conf.announceSSL || (worker._conf.ssl && worker._conf.ssl.key) ? 'https' : 'http'
        });
    });
}
function startWSHandlersMonitoring(worker) {
    _.each(worker._workers, function (worker) {
        worker.on('message', function (message) {
            if (!_.isObject(message) || message.type !== 'chatUp:stats') {
                return;
            }
            worker.stats = message.stats;
        });
    });
}
function registerInRedis(worker, redisConnection, stats) {
    return new Promise(function (resolve, reject) {
        var keyName = "chatUp:chatServer:" + worker._conf.uuid;
        redisConnection.multi()
            .hmset(keyName, {
            host: worker._conf.host,
            connections: _(worker._workers).map('stats').map('connections').sum(),
            pubStats: JSON.stringify(_(worker._workers).map('stats').map('channels').flatten().compact().reduce(function (stats, channel) {
                stats[channel.name] = _.union(stats[channel.name] || [], channel.publishers);
                return stats;
            }, {})),
            subStats: JSON.stringify(stats)
        })
            .pexpire(keyName, worker._conf.expireDelay)
            .exec(function (err, results) {
            if (err) {
                logger.captureError(logger.error('Redis register', { err: err }));
                return reject(err);
            }
            return resolve();
        });
    });
}
function startAlivePing(worker, redisConnection) {
    var interval = setInterval(function () {
        getNginxStats(worker).then(function (nginxStats) {
            return registerInRedis(worker, redisConnection, nginxStats);
        }).catch(function (err) {
            logger.captureError(logger.error('Nginx stats error', { err: err }));
            debug(err.stack);
            registerInRedis(worker, redisConnection, { err: 'nginxStats' });
        });
    }, worker._conf.expireDelay * 0.5);
    interval.unref();
}
