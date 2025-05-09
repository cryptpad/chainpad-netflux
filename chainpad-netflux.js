/*
 * Copyright 2024 XWiki SAS
 *
 * This is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as
 * published by the Free Software Foundation; either version 2.1 of
 * the License, or (at your option) any later version.
 *
 * This software is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this software; if not, write to the Free
 * Software Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA
 * 02110-1301 USA, or see the FSF site: http://www.fsf.org.
 */
(function () {
var factory = function (Netflux, Nacl, NaclUtil) {
    var USE_HISTORY = true;
    var CPNF = {};

    var verbose = function (x) { console.log(x); };
    verbose = function () {}; // comment out to enable verbose logging

    var unBencode = function (str) { return str.replace(/^\d+:/, ''); };

    var removeCp = CPNF.removeCp = function (str) {
        return str.replace(/^cp\|([A-Za-z0-9+\/=]{0,20}\|)?/, '');
    };

    CPNF.start = function (config) {
        // make sure configuration is defined
        config = config || {};

        var network = config.network;
        var websocketUrl = config.websocketURL;
        var userName = config.userName;
        var channel = config.channel;
        var Crypto = config.crypto;
        var readOnly = config.readOnly || false;
        var ChainPad = !config.noChainPad && (config.ChainPad || globalThis.ChainPad);
        var useHistory = (typeof(config.useHistory) === 'undefined') ? USE_HISTORY : !!config.useHistory;
        var stopped = false;
        var lastKnownHash = config.lastKnownHash;
        var lastSent = {};
        var messagesQueue = [];

        var priority = config.priority || 2;

        var Cache = config.Cache;
        var channelCache;
        var initialCache = false;

        var txid = Math.floor(Math.random() * 1000000);

        var metadata = config.metadata || {};
        var validateKey = metadata.validateKey = config.validateKey || metadata.validateKey;
        metadata.owners = config.owners || metadata.owners;
        metadata.expire = config.expire || metadata.expire;

        var initializing = true;
        var reconnecting = false;
        var toReturn = {
            setReadOnly: function (state, crypto) {
                readOnly = state;
                if (crypto) {
                    Crypto = crypto;
                }
            }
        };
        var joinSession = function () {};
        var realtime;
        var lastKnownHistoryKeeper;
        var historyKeeperChange = [];
        var wcObject = {
            send: function () {}
        };

        var createRealtime = function() {
            if (realtime && typeof(realtime.abort) === "function") { realtime.abort(); }
            var chainpad = ChainPad.create({
                userName: userName,
                initialState: config.initialState,
                transformFunction: config.transformFunction,
                patchTransformer: config.patchTransformer,
                validateContent: config.validateContent,
                avgSyncMilliseconds: config.avgSyncMilliseconds,
                logLevel: typeof(config.logLevel) !== 'undefined'? config.logLevel : 1
            });

            // If we have a cache, use it: if this cache is deprecated, ChainPad's pruning system
            // will automatically delete it from memory
            if (Cache && Array.isArray(channelCache) && channelCache.length) {
                channelCache.forEach(function (obj) {
                    var patch = obj.patch;
                    if (!/^\[/.test(patch)) {
                        try {
                            patch = Crypto.decrypt(patch, validateKey, true);
                        } catch (err) {
                            console.error(patch, validateKey, channel);
                            console.error(err);
                        }
                        patch = unBencode(patch);
                    }
                    chainpad.message(patch);
                });
                // If userDoc is empty string, delete the cache
                var doc = chainpad.getUserDoc();
                if (doc === '') {
                    chainpad.abort();
                    channelCache = [];
                    Cache.clearChannel(channel);
                    return createRealtime();
                }
            }

            // Sending a message...
            chainpad.onMessage(function (msg, cb, curve) {
                wcObject.send(msg, cb, curve);
            });

            chainpad.onPatch(function (patch) {
                if (config.onRemote) {
                    config.onRemote({
                        realtime: chainpad,
                        patch
                    });
                }
            });

            return chainpad;
        };

        var userList = {
            change : [],
            onChange : function(newData) {
                userList.change.forEach(function (el) {
                    el(newData);
                });
            },
            users: []
        };

        var onJoining = function(peer) {
            if (config.onJoin)  { config.onJoin(peer); }
            if(peer.length !== 32) { return; }
            var list = userList.users;
            var index = list.indexOf(peer);
            if(index === -1) {
                userList.users.push(peer);
            }
            userList.onChange();
        };

        var connectTo = function () {};

        // update UI components to show that one of the other peers has left
        var onLeaving = function(peer) {
            if (config.onLeave)  { config.onLeave(peer); }
            var list = userList.users;
            var index = list.indexOf(peer);
            if(index !== -1) {
                userList.users.splice(index, 1);
            }
            userList.onChange();
        };

        var onReady = function(wc, network) {
            // Trigger onReady only if not ready yet. This is important because the history keeper sends a direct
            // message through "network" when it is synced, and it triggers onReady for each channel joined.
            if (!initializing) { return; }

            // If we have a chainpad instance AND this instance is empty AND we have a
            // non-empty cache, it means the cache is probably corrupted: reset with no cache.
            // If we don't have a chainpad instance, the application has to detect itself if the
            // cache is corrupted.
            try {
                var doc = realtime && realtime.getUserDoc();
                if (initialCache && realtime && (doc === '' || doc === config.initialState)) {
                    return void toReturn.resetCache();
                }
            } catch (e) {
                console.error(e);
            }

            if (realtime) { realtime.start(); }

            if(config.setMyID) {
                config.setMyID({
                    myID: wc.myID
                });
            }

            // we're fully synced
            initializing = false;

            if (config.onReady) {
                config.onReady({
                    realtime: realtime,
                    network: network,
                    userList: userList,
                    myId: wc.myID,
                    leave: wc.leave,
                    metadata: metadata,
                });
            }

            if (messagesQueue.length) {
                messagesQueue.forEach(function (f) {
                    if (typeof(f) !== "function") { return; }
                    f();
                });
                messagesQueue = [];
            }
        };

        var onChannelError = function (parsed, wc) {
            if (config.onChannelError) {
                config.onChannelError({
                    channel: wc.id,
                    type: parsed.error,
                    loaded: !initializing,
                    error: parsed.error,
                    message: parsed.message,
                });
            }
            if (parsed.error === "EUNKNOWN") { // Invalid last known hash
                lastKnownHash = undefined;
                if (wc) { wc.leave(); }
                // We're going to rejoin the channel without lastKnownHash.
                // Kill chainpad and make a new one to start fresh.
                if (Cache) {
                    channelCache = [];
                    Cache.clearChannel(channel, function () {
                        if (ChainPad) {
                            toReturn.realtime = realtime = createRealtime();
                        }
                        joinSession(network, connectTo);
                    });
                    return;
                }
                joinSession(network, connectTo);
                return;
            }
            if (typeof (toReturn.stop) === "function") {
                try {
                    toReturn.stop();
                } catch (e) {}
            }
        };

        var firstFillCache = true;
        var fillCache = function (obj) {
            if (!Cache) { return; }
            if (channelCache.length &&
                channelCache[channelCache.length - 1].hash === obj.hash) { return; }

            // Mark the first message of the cache as a checkpoint: it's either a true
            // checkpoint and already marked as such, or it's the first message of the chain.
            if (!channelCache.length && firstFillCache) {
                obj.isCheckpoint = true;
                firstFillCache = false;
            }

            // the cache should start with a "checkpoint"
            if (!channelCache.length && !obj.isCheckpoint) { return; }
            channelCache.push(obj);

            Cache.storeCache(channel, validateKey, channelCache, function (err) {
                if (err) {
                    // One patch was not stored? invalidate the cache
                    Cache.clearChannel(channel, function () {
                        console.warn('Cache cleared', channel);
                    });
                    var _cache = channelCache;
                    channelCache = [];
                    return void console.error(err, channel, _cache, validateKey);
                }
            });
        };

        var onMessage = function (peer, msg, wc, network, direct) {
            // unpack the history keeper from the webchannel
            var hk = network.historyKeeper;
            var isHk = peer === hk;

            // Old server
            if (wc && (msg === 0 || msg === '0')) {
                return void onReady(wc, network);
            }
            if (direct && peer !== hk) {
                return;
            }
            if (direct) {
                var parsed = JSON.parse(msg);

                // If there is a txid, make sure it's ours or abort
                if (parsed.txid && parsed.txid !== txid) { return; }

                if (parsed.validateKey && parsed.channel) {
                    if (parsed.channel === wc.id && !validateKey) {
                        validateKey = parsed.validateKey;
                    }
                    if (parsed.channel === wc.id) {
                        metadata = parsed;
                        if (config.onMetadataUpdate && !initializing) {
                            config.onMetadataUpdate(metadata);
                        }
                    }
                    // We have to return even if it is not the current channel:
                    // we don't want to continue with other channels messages here
                    return;
                }
                if (parsed.state && parsed.state === 1 && parsed.channel) {
                    if (parsed.channel === wc.id) {
                        // If some messages were sent locally but not received by the server,
                        // callback with an error
                        Object.keys(lastSent).forEach(function (h) {
                            if (typeof(lastSent[h]) === "function") {
                                lastSent[h]('FAILED');
                            }
                        });
                        lastSent = {};
                        onReady(wc, network);
                    }
                    // We have to return even if it is not the current channel:
                    // we don't want to continue with other channels messages here
                    return;
                }
            }
            if (isHk) {
                // if the peer is the 'history keeper', extract their message
                var parsed1 = JSON.parse(msg);

                // If there is a txid, make sure it's ours or abort
                if (Array.isArray(parsed1) && parsed1[0] && parsed1[0] !== txid) {
                    return;
                }

                // First check if it is an error message (EXPIRED/DELETED)
                if (parsed1.channel === wc.id && parsed1.error) {
                    onChannelError(parsed1, wc);
                    return;
                }

                msg = parsed1[4];
                // Check that this is a message for us
                if (parsed1[3] !== wc.id) { return; }
            }

            lastKnownHash = msg.slice(0,64);

            if (typeof(lastSent[lastKnownHash]) === "function") {
                lastSent[lastKnownHash](null, lastKnownHash);
                delete lastSent[lastKnownHash];
                return;
            }


            var isCp = /^cp\|/.test(msg);
            msg = removeCp(msg);
            try {
                msg = Crypto.decrypt(msg, validateKey, isHk);
            } catch (err) {
                console.error(msg, validateKey, channel);
                console.error(err);
            }

            var senderCurve;
            var isString = typeof(msg) === "string";
            if (!isString && msg.content) {
                senderCurve = msg.author;
                msg = msg.content;
            }

            verbose(msg);

            if (!initializing) {
                if (config.onLocal) {
                    config.onLocal(true);
                }
            }

            // slice off the bencoded header
            // Why are we getting bencoded stuff to begin with?
            // FIXME this shouldn't be necessary
            var message = isString ? unBencode(msg) : msg;

            var apply = function () {
                // pass the message into Chainpad
                // don't block chainpad netflux if one handler throws
                try {
                    if (realtime && isString) { realtime.message(message); }
                    if (config.onMessage) {
                        var obj = {
                            time: parsed1 ? parsed1[5] : (+new Date())
                        };
                        config.onMessage(message, peer, validateKey,
                                         isCp, lastKnownHash, senderCurve, obj);
                    }
                    var isCacheCp = isCp;
                    if (config.isCacheCheckpoint) {
                        isCacheCp = config.isCacheCheckpoint(message, senderCurve);
                    }
                    fillCache({
                        patch: message,
                        hash: lastKnownHash,
                        isCheckpoint: isCacheCp,
                        author: senderCurve,
                        time: parsed1 ? parsed1[5] : (+new Date())
                    });
                } catch (e) {
                    console.error(e);
                }
            };

            // If this is a message broadcasted to this channel by another user AND
            // if we're not fully synced yet, put the message in a queue
            if (initializing && peer !== hk) {
                messagesQueue.push(apply);
                return;
            }

            // Otherwise apply it directly
            apply();
        };

        // If our provided crypto uses asymmetric encryption, we need to pass
        // the recipient's curvePublic key
        var msgOut = function(msg, curvePublic) {
            if (readOnly) { return; }
            try {
                var cmsg = Crypto.encrypt(msg, curvePublic);
                if (msg.indexOf('[4') === 0) {
                    var id = '';
                    if (Nacl && NaclUtil) {
                        var hash = Nacl.hash(NaclUtil.decodeUTF8(msg));
                        id = NaclUtil.encodeBase64(hash.slice(0, 8)) + '|';
                    } else {
                        console.log("Checkpoint sent without an ID. Nacl is missing.");
                    }
                    cmsg = 'cp|' + id + cmsg;
                }
                return cmsg;
            } catch (err) {
                console.log(msg);
                throw err;
            }
        };

        // We use an object to store the webchannel so that we don't have to push new handlers to chainpad
        // and remove the old ones when reconnecting and keeping the same 'realtime' object
        // See realtime.onMessage below: we call wc.bcast(...) but wc may change
        var onOpen = function(wc, network, firstConnection) {
            wcObject.wc = wc;
            channel = wc.id;

            // Add the existing peers in the userList
            wc.members.forEach(onJoining);

            // Add the handlers to the WebChannel
            var onMessageHandler = function (msg, sender) { //Channel msg
                onMessage(sender, msg, wc, network);
            };
            wc.on('message', onMessageHandler);
            wc.on('join', onJoining);
            wc.on('leave', onLeaving);

            wcObject.stop = function () {
                wc.off('message', onMessageHandler);
                wc.off('join', onJoining);
                wc.off('leave', onLeaving);
                wc.leave();
                if (realtime) {
                    realtime.abort();
                }
            };

            if (firstConnection) {
                wcObject.send = function (_message, cb, curvePublic) {
                    // Filter messages sent by Chainpad to make it compatible with Netflux
                    var message = msgOut(_message, curvePublic);
                    if(message) {
                        var hash = message.slice(0, 64);
                        var isCacheCp = /^cp\|/.test(message);
                        if (config.isCacheCheckpoint) {
                            isCacheCp = config.isCacheCheckpoint(_message, curvePublic);
                        }

                        // If we disconnect before receiving the ACK from the server, store cb
                        // in memory to call it when we reconnect if we see our message in the
                        // recent history. We also have to update the cache if the message
                        // was successfully stored.
                        lastSent[hash] = function (err, _hash) {
                            if (!err && _hash) {
                                fillCache({
                                    patch: removeCp(_message),
                                    hash: hash,
                                    isCheckpoint: isCacheCp,
                                    author: curvePublic,
                                    time: +new Date()
                                });
                            }
                            cb(err, _hash);
                        };

                        wcObject.wc.bcast(message).then(function() {
                            lastKnownHash = hash;
                            delete lastSent[hash];
                            fillCache({
                                patch: removeCp(_message),
                                hash: hash,
                                isCheckpoint: isCacheCp,
                                author: curvePublic,
                                time: +new Date()
                            });
                            cb(null, hash);
                        }, function(err) {
                            // The message has not been sent, display the error.
                            console.error(err);

                            if (err && (err.type === 'enoent' || err.type === 'ENOENT')) {
                                // Channel not in memory on the server: join again
                                wcObject.wc.leave();
                                if (stopped) {
                                    delete lastSent[hash];
                                    return void cb('STOPPED');
                                }
                                initializing = true;
                                network.join(channel, priority).then(function (wc) {
                                    onOpen(wc, network, false);
                                    wcObject.send(_message, cb, curvePublic);
                                });
                            } else {
                                // Otherwise tell cryptpad that your message was not sent
                                delete lastSent[hash];
                                cb((err && err.type) || err);
                            }
                        });
                    }
                };

                if (ChainPad && !realtime) {
                    toReturn.realtime = realtime = createRealtime();
                }

                if (config.onInit) {
                    config.onInit({
                        myID: wc.myID,
                        realtime: realtime,
                        getLag: network.getLag,
                        userList: userList,
                        network: network,
                        channel: channel,
                    });
                }

            }

            if (config.onConnect) {
                config.onConnect(wc, wcObject.send);
            }

            // Get the channel history
            if (useHistory) {
                var hk;

                wc.members.forEach(function (p) {
                    if (p.length === 16) { hk = p; }
                });
                if (lastKnownHistoryKeeper !== hk) {
                    network.historyKeeper = hk;
                    lastKnownHistoryKeeper = hk;
                    historyKeeperChange.forEach(function (f) {
                        f(hk);
                    });
                }

                // Add the validateKey if we are the channel creator and we have a validateKey
                var sendGetHistory = function () {
                    var cfg = {
                        txid: txid,
                        priority: priority,
                        lastKnownHash: lastKnownHash,
                        metadata: metadata
                    };
                    if (Cache && Array.isArray(channelCache) && channelCache.length) {
                        cfg.lastKnownHash = channelCache[channelCache.length - 1].hash;
                    }
                    // Reset the queue when asking for history: the pending messages will be included
                    // in the new history
                    messagesQueue = [];
                    var msg = ['GET_HISTORY', wc.id, cfg];
                    if (hk) { network.sendto(hk, JSON.stringify(msg)); }
                };
                sendGetHistory();

                // If the resulting chainpad is empty with our cache, reste it and ask for normal
                // history.
                toReturn.resetCache = function () {
                    // ignore all history messages coming from the GET_HISTORY based on the cache:
                    // use a new txid to ignore incoming messages
                    initializing = true;
                    channelCache = [];
                    if (Cache) { Cache.clearChannel(channel); }
                    txid = Math.floor(Math.random() * 1000000);
                    onChannelError({
                        error: "EUNKNOWN",
                        message: "Corrupted cache"
                    }, wc);
                };
            } else {
                onReady(wc, network);
            }
        };

        // Set a flag to avoid calling onAbort or onConnectionChange when the user is leaving the page
        var isIntentionallyLeaving = false;
        if (typeof(window) !== 'undefined') {
            window.addEventListener("beforeunload", function () {
                isIntentionallyLeaving = true;
            });
        }

        var findChannelById = function(webChannels, channelId) {
            var webChannel;

            // Array.some terminates once a truthy value is returned
            // best case is faster than forEach, though webchannel arrays seem
            // to consistently have a length of 1
            webChannels.some(function(chan) {
                if(chan.id === channelId) { webChannel = chan; return true;}
            });
            return webChannel;
        };

        var onConnectError = function (err) {
            if (config.onError) {
                config.onError({
                    type: err.type || err,
                    message: err.message,
                    error: err.type,
                    loaded: !initializing
                });
            }
        };

        joinSession = function (endPoint, cb) {
            var promise;
            if (typeof(endPoint) === 'string') {
                promise = Netflux.connect(endPoint);
            }
            var join = function () {
                reconnecting = false;
                // a websocket URL has been provided
                // connect to it with Netflux.
                if (typeof(endPoint) === 'string') {
                    promise.then(cb, onConnectError);
                } else if (typeof(endPoint.then) === 'function') {
                    // a netflux network promise was provided
                    // connect to it and use a channel
                    endPoint.then(cb, onConnectError);
                } else {
                    // assume it's a network and try to connect.
                    cb(endPoint);
                }
            };

            // Check if we have a cache for this channel
            if (Cache && !reconnecting) {
                Cache.getChannelCache(channel, function (err, cache) {
                    validateKey = cache ? cache.k : undefined;
                    channelCache = cache ? cache.c : [];

                    // Empty cache? join the network
                    if (!channelCache.length) {
                        return void join();
                    }

                    initialCache = true;

                    // Existing cache: send the cache content and then join the network
                    if (config.onCacheStart) {
                        config.onCacheStart();
                    }
                    if (ChainPad) {
                        toReturn.realtime = realtime = createRealtime();
                    }

                    // "createRealtime" will empty the cache if it detects that it results in an
                    // empty string in chainpad
                    if (!channelCache.length) { return void join(); }

                    if (config.onMessage) {
                        channelCache.forEach(function (obj) {
                            var _obj = {
                                time: obj.time
                            };
                            config.onMessage(obj.patch, "cache", validateKey,
                                             obj.isCheckpoint, obj.hash, obj.author, _obj);
                        });
                    }
                    if (config.onCacheReady) {
                        config.onCacheReady({
                            id: channel,
                            realtime: realtime,
                            networkPromise: promise
                        });
                    }

                    join();
                });
                toReturn.resetCache = function () {
                    if (Cache) { Cache.clearChannel(channel); }
                    channelCache = [];
                };
                return;
            }

            // No cache provided, join the channel
            join();
        };

        var firstConnection = true;
        /*  Connect to the Netflux network, or fall back to a WebSocket
            in theory this lets us connect to more netflux channels using only
            one network. */
        connectTo = function (network, first) {
            if (stopped) { return; }
            // join the netflux network, promise to handle opening of the channel
            network.join(channel || null, priority).then(function(wc) {
                if (stopped) {
                    try { wc.leave(); } catch (e) {}
                    return;
                }
                onOpen(wc, network, first);
            }, function(error) {
                // If there is an allow list and you're not authenticated yet,
                // tyr to authenticate from CryptPad
                if (error && error.type === 'ERESTRICTED' && Array.isArray(error.message)) {
                    if (config.onRejected) {
                        return void config.onRejected(error.message, function (err) {
                            if (err) { return void onConnectError(error); }
                            connectTo(network, first);
                        });
                    }
                }
                onConnectError(error);
            });
        };

        toReturn.stop = function () {
            stopped = true;
        };

        joinSession(network || websocketUrl, function (_network) {
            network = _network;
            // pass messages that come out of netflux into our local handler
            if (firstConnection) {
                firstConnection = false;

                if (stopped) { return; }
                var onDisconnectHandler = function (reason) {
                    if (isIntentionallyLeaving) { return; }
                    if (reason === "network.disconnect() called") { return; }
                    if (config.onConnectionChange) {
                        config.onConnectionChange({
                            state: false
                        });
                        return;
                    }
                    if (config.onAbort) {
                        config.onAbort({
                            reason: reason
                        });
                    }
                };
                var onReconnectHandler = function (uid) {
                    if (config.onConnectionChange) {
                        config.onConnectionChange({
                            state: true,
                            myId: uid
                        });
                        var afterReconnecting = function () {
                            initializing = true;
                            reconnecting = true;
                            userList.users=[];
                            joinSession(network, connectTo);
                        };
                        if (config.beforeReconnecting) {
                            config.beforeReconnecting(function (newKey, newContent) {
                                channel = newKey;
                                config.initialState = newContent;
                                afterReconnecting();
                            });
                            return;
                        }
                        afterReconnecting();
                    }
                };
                var onMessageHandler = function (msg, sender) { // Direct message
                    var wchan = findChannelById(network.webChannels, channel);
                    if(wchan) {
                        onMessage(sender, msg, wchan, network, true);
                    }
                };

                network.on('disconnect', onDisconnectHandler);
                network.on('reconnect', onReconnectHandler);
                network.on('message', onMessageHandler);

                toReturn.network = network;
                toReturn.stop = function () {
                    if (wcObject && wcObject.stop) {
                        wcObject.stop();
                    }
                    var wchan = findChannelById(network.webChannels, channel);
                    if (wchan) {
                        try {
                            wchan.leave('');
                        } catch (e) {}
                    }
                    network.off('disconnect', onDisconnectHandler);
                    network.off('reconnect', onReconnectHandler);
                    network.off('message', onMessageHandler);
                    // TODO chainpad.kill?
                    stopped = true;
                };

                network.onHistoryKeeperChange = function (todo) {
                    historyKeeperChange.push(todo);
                };

            }

            connectTo(network, true);
        });

        return toReturn;
    };
    return CPNF;
};

    if (typeof(module) !== 'undefined' && module.exports) {
        module.exports = factory(
            require("netflux-websocket"),
            require('tweetnacl/nacl-fast'),
            require('tweetnacl-util')
        );
    } else if ((typeof(define) !== 'undefined' && define !== null) && (define.amd !== null)) {
        define('chainpad-netflux', [
            'netflux-client',
            '/components/tweetnacl/nacl-fast.min.js',
            '/components/tweetnacl-util/nacl-util.min.js'
        ], factory);
    } else {
        // I'm not gonna bother supporting any other kind of instanciation
    }
}());
