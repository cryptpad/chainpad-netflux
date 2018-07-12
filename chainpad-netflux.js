/*
 * Copyright 2014 XWiki SAS
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
define([
    '/bower_components/netflux-websocket/netflux-client.js'
], function (Netflux) {
    var USE_HISTORY = true;
    var module = { exports: {} };

    var verbose = function (x) { console.log(x); };
    verbose = function () {}; // comment out to enable verbose logging

    var unBencode = function (str) { return str.replace(/^\d+:/, ''); };

    module.exports.start = function (config) {
        var websocketUrl = config.websocketURL;
        var userName = config.userName;
        var channel = config.channel;
        var Crypto = config.crypto;
        var validateKey = config.validateKey;
        var owners = config.owners;
        var password = config.password;
        var expire = config.expire;
        var readOnly = config.readOnly || false;
        var ChainPad = config.ChainPad || window.ChainPad;
        var useHistory = (typeof(config.useHistory) === 'undefined') ? USE_HISTORY : !!config.useHistory;

        // make sure configuration is defined
        config = config || {};

        var initializing = true;
        var toReturn = {};
        var messagesHistory = [];
        var chainpadAdapter = {};
        var realtime;
        var network = config.network;
        var lastKnownHash;
        var historyKeeperChange = [];
        var metadata = {};

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
            if(peer.length !== 32) { return; }
            var list = userList.users;
            var index = list.indexOf(peer);
            if(index === -1) {
                userList.users.push(peer);
            }
            userList.onChange();
        };

        var onReady = function(wc, network) {
            // Trigger onReady only if not ready yet. This is important because the history keeper sends a direct
            // message through "network" when it is synced, and it triggers onReady for each channel joined.
            if (!initializing) { return; }

            realtime.start();

            if(config.setMyID) {
                config.setMyID({
                    myID: wc.myID
                });
            }
            // Trigger onJoining with our own Cryptpad username to tell the toolbar that we are synced
            if (!readOnly) {
                onJoining(wc.myID);
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
                    metadata: metadata
                });
            }
        };

        var onMessage = function(peer, msg, wc, network, direct) {
            // unpack the history keeper from the webchannel
            var hk = network.historyKeeper;

            // Old server
            if(wc && (msg === 0 || msg === '0')) {
                onReady(wc, network);
                return;
            }
            if (direct && peer !== hk) {
                return;
            }
            if (direct) {
                var parsed = JSON.parse(msg);
                if (parsed.validateKey && parsed.channel) {
                    if (parsed.channel === wc.id && !validateKey) {
                        validateKey = parsed.validateKey;
                    }
                    if (parsed.channel === wc.id) {
                        metadata = parsed;
                    }
                    // We have to return even if it is not the current channel:
                    // we don't want to continue with other channels messages here
                    return;
                }
                if (parsed.state && parsed.state === 1 && parsed.channel) {
                    if (parsed.channel === wc.id) {
                        onReady(wc, network);
                    }
                    // We have to return even if it is not the current channel:
                    // we don't want to continue with other channels messages here
                    return;
                }
            }
            // The history keeper is different for each channel :
            // no need to check if the message is related to the current channel
            if (peer === hk){
                // if the peer is the 'history keeper', extract their message
                var parsed1 = JSON.parse(msg);
                msg = parsed1[4];
                // Check that this is a message for us
                if (parsed1[3] !== wc.id) { return; }
            }

            lastKnownHash = msg.slice(0,64);
            var message = chainpadAdapter.msgIn(peer, msg);

            verbose(message);

            if (!initializing) {
                if (config.onLocal) {
                    config.onLocal(true);
                }
            }

            // slice off the bencoded header
            // Why are we getting bencoded stuff to begin with?
            // FIXME this shouldn't be necessary
            message = unBencode(message);//.slice(message.indexOf(':[') + 1);

            // pass the message into Chainpad
            realtime.message(message);
        };

        // update UI components to show that one of the other peers has left
        var onLeaving = function(peer) {
            var list = userList.users;
            var index = list.indexOf(peer);
            if(index !== -1) {
                userList.users.splice(index, 1);
            }
            userList.onChange();
        };

        // shim between chainpad and netflux
        chainpadAdapter = {
            msgIn : function(peerId, msg) {
                msg = msg.replace(/^cp\|([A-Za-z0-9+\/=]+\|)?/, '');
                try {
                    var isHk = peerId.length !== 32;
                    var decryptedMsg = Crypto.decrypt(msg, validateKey, isHk);
                    messagesHistory.push(decryptedMsg);
                    return decryptedMsg;
                } catch (err) {
                    console.error(err);
                    return msg;
                }
            },
            msgOut : function(msg) {
                if (readOnly) { return; }
                try {
                    var cmsg = Crypto.encrypt(msg);
                    if (msg.indexOf('[4') === 0) {
                        var id = '';
                        if (window.nacl) {
                            var hash = window.nacl.hash(window.nacl.util.decodeUTF8(msg));
                            id = window.nacl.util.encodeBase64(hash.slice(0, 8)) + '|';
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
            }
        };

        var createRealtime = function() {
            return ChainPad.create({
                userName: userName,
                initialState: config.initialState,
                transformFunction: config.transformFunction,
                patchTransformer: config.patchTransformer,
                validateContent: config.validateContent,
                avgSyncMilliseconds: config.avgSyncMilliseconds,
                logLevel: typeof(config.logLevel) !== 'undefined'? config.logLevel : 1
            });
        };

        // We use an object to store the webchannel so that we don't have to push new handlers to chainpad
        // and remove the old ones when reconnecting and keeping the same 'realtime' object
        // See realtime.onMessage below: we call wc.bcast(...) but wc may change
        var wcObject = {};
        var onOpen = function(wc, network, initialize) {
            wcObject.wc = wc;
            channel = wc.id;

            // Add the existing peers in the userList
            wc.members.forEach(onJoining);

            // Add the handlers to the WebChannel
            wc.on('message', function (msg, sender) { //Channel msg
                onMessage(sender, msg, wc, network);
            });
            wc.on('join', onJoining);
            wc.on('leave', onLeaving);

            if (initialize) {
                toReturn.realtime = realtime = createRealtime();

                realtime._patch = realtime.patch;
                realtime.patch = function (patch, x, y) {
                    if (initializing) {
                        console.error("attempted to change the content before chainpad was synced");
                    }
                    return realtime._patch(patch, x, y);
                };
                realtime._change = realtime.change;
                realtime.change = function (offset, count, chars) {
                    if (initializing) {
                        console.error("attempted to change the content before chainpad was synced");
                    }
                    return realtime._change(offset, count, chars);
                };

                if (config.onInit) {
                    config.onInit({
                        myID: wc.myID,
                        realtime: realtime,
                        getLag: network.getLag,
                        userList: userList,
                        network: network,
                        channel: channel
                    });
                }

                // Sending a message...
                realtime.onMessage(function(message, cb) {
                    // Filter messages sent by Chainpad to make it compatible with Netflux
                    message = chainpadAdapter.msgOut(message);
                    if(message) {
                        // Do not remove wcObject, it allows us to use a new 'wc' without changing the handler if we
                        // want to keep the same chainpad (realtime) object
                        wcObject.wc.bcast(message).then(function() {
                            cb();
                        }, function(err) {
                            // The message has not been sent, display the error.
                            console.error(err);
                        });
                    }
                });

                realtime.onPatch(function () {
                    if (config.onRemote) {
                        config.onRemote({
                            realtime: realtime
                        });
                    }
                });
            }

            // Get the channel history
            if(useHistory) {
                var hk;

                wc.members.forEach(function (p) {
                    if (p.length === 16) { hk = p; }
                });
                if (network.historyKeeper !== hk) {
                    network.historyKeeper = hk;
                    historyKeeperChange.forEach(function (f) {
                        f(hk);
                    });
                }

                // Add the validateKey if we are the channel creator and we have a validateKey
                var cfg = {
                    validateKey: validateKey,
                    lastKnownHash: lastKnownHash,
                    owners: owners,
                    expire: expire,
                    password: password
                };
                var msg = ['GET_HISTORY', wc.id, cfg];
                if (hk) { network.sendto(hk, JSON.stringify(msg)); }
            }
            else {
              onReady(wc, network);
            }
        };

        // Set a flag to avoid calling onAbort or onConnectionChange when the user is leaving the page
        var isIntentionallyLeaving = false;
        window.addEventListener("beforeunload", function () {
            isIntentionallyLeaving = true;
        });

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
                    error: err.type
                });
            }
        };

        var joinSession = function (endPoint, cb) {
            // a websocket URL has been provided
            // connect to it with Netflux.
            if (typeof(endPoint) === 'string') {
                Netflux.connect(endPoint).then(cb, onConnectError);
            } else if (typeof(endPoint.then) === 'function') {
                // a netflux network promise was provided
                // connect to it and use a channel
                endPoint.then(cb, onConnectError);
            } else {
                // assume it's a network and try to connect.
                cb(endPoint);
            }
        };

        var firstConnection = true;
        /*  Connect to the Netflux network, or fall back to a WebSocket
            in theory this lets us connect to more netflux channels using only
            one network. */
        var connectTo = function (network) {
            // join the netflux network, promise to handle opening of the channel
            network.join(channel || null).then(function(wc) {
                onOpen(wc, network, firstConnection);
                firstConnection = false;
            }, function(error) {
                console.error(error);
            });
        };

        joinSession(network || websocketUrl, function (network) {
            // pass messages that come out of netflux into our local handler
            if (firstConnection) {
                toReturn.network = network;

                network.onHistoryKeeperChange = function (todo) {
                    historyKeeperChange.push(todo);
                };

                network.on('disconnect', function (reason) {
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
                });

                network.on('reconnect', function (uid) {
                    if (config.onConnectionChange) {
                        config.onConnectionChange({
                            state: true,
                            myId: uid
                        });
                        var afterReconnecting = function () {
                            initializing = true;
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
                });

                network.on('message', function (msg, sender) { // Direct message
                    var wchan = findChannelById(network.webChannels, channel);
                    if(wchan) {
                      onMessage(sender, msg, wchan, network, true);
                    }
                });
            }

            connectTo(network);
        }, onConnectError);

        return toReturn;
    };
    return module.exports;
});
