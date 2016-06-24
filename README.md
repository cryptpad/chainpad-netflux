# chainpad-netflux
A convenient wrapper around the chainpad realtime engine and the netflux transport API

## Usage

Use chainpad-netflux in conjunction with a [chainpad server](http://github.com/xwiki-labs/chainpad-server), requirejs, and any combination of a [growing number of chainpad-related modules](https://github.com/xwiki-labs/realtime-handbook/blob/master/REPOSITORIES.md).

```javascript
define([
    '/api/config?cb=' + Math.random().toString(16).slice(2),
    '/bower_components/chainpad-netflux/chainpad-netflux.js',
    '/bower_components/textpatcher/TextPatcher.amd.js',
    '/bower_components/chainpad-crypto/crypto.js'
], function (Config, Realtime, TextPatcher, Crypto) {

    /*  Some basic configuration for connecting to peers,
        and encrypting content */
    var config = {
        initialState: '',
        channel: '???',
        websocketURL: Config.websocketURL,
        cryptKey: '???',
        crypto: Crypto
    };

    config.onInit = function (info) {
        // to be called immediately after the object has been created
    };

    config.onReady = function (info) {
        // initialize your app when your realtime session has synchronized
    };

    config.onAbort = function () {
        // handle disconnection
    };

    config.onRemote = function () {
        // integrate remote users changes
    };

    config.onLocal = function () {
        // serialize your interface's content to other users
    };

    // create your realtime object
    var rt = Realtime.start(config);

    // listen for changes
    $('#someUserInterfaceElement').on('change', config.onLocal);
});
```

## API

Chainpad-Netflux exports a single method, `start`, which accepts a configuration object and creates a realtime session.

### Configuration Parameters

#### initialState

The initial state of the document (string), which must be consistent among clients for Chainpad to function optimally.

Defaults to `''` (empty string) if no alternative is provided.

#### channel

A 32 character Netflux channel identifier (string).

#### websocketURL

(Optional if you can provide a netflux network)
String. probably provided by your server's config API.

#### network

A netflux network object, to be used in situations where your network has already been initialized, and you would like to create or connect to an additional channel.

A `network` attribute in your config will override the `websocketURL` if present.

#### crypto

A crypto module, such as [chainpad-crypto](https://github.com/xwiki-labs/chainpad-crypto), which encrypts and decrypts content before and after it is relayed by the server.

#### cryptKey

The encryption key used to encrypt your content.
See `chainpad-crypto` (linked above) for more information.

#### onInit

function (info) which is executed once Chainpad has begun to initialize.
Provides an object (info) exposing information which would otherwise be internal:

* _myID_ (string), a Netflux user ID
* _realtime_ (object), the Chainpad realtime object
* getLag (function), return your client's current lag
* userList (array), the list of users
* channel (object), the netflux channel object

#### onReady

function (info), which is executed once Chainpad has fully synchronized the document's history.

info exposes `realtime` (the chainpad object), as in `onInit`, in case you decided not to supply an onInit call.
Your app will most likely need access to this object so that it can inspect the content of the collaborative document at any given time.

#### onAbort

function (info), which is executed once your client is considered disconnected from the Netflux network.

info exposes `reason`, a string specifying the circumstances of your disconnection.

#### onRemote

function (info), which is executed each time your client becomes aware of remote users' changes to the document.

info exposes `realtime` (the chainpad object).

Logic for integrating remote changes into your user's interface should be implemented here.

#### onLocal

function (), which must implement logic for reading a local user's changes into the Chainpad instance.
Due to the fact that remote changes are received asynchronously, this function will also be executed prior to `onRemote` being executed, ensuring that remote changes do not clobber your local changes before they are inserted into the collaborative document.

In instances where these changes would conflict, `transformFunction` (specified below) will be called.

#### transformFunction

The pluggable _Operational Transformation_ function to be supplied to Chainpad.
See [Chainpad: configuration parameters](https://github.com/xwiki-contrib/chainpad#configuration-parameters) for more information.

#### validateContent

The pluggable patch verification function to be supplied to chainpad.
See [Chainpad: configuration parameters](https://github.com/xwiki-contrib/chainpad#configuration-parameters) for more information.

## Installation

`bower install chainpad-netflux`

## License

This software is and will always be available under the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the License, or (at your option)
any later version. If you wish to use this technology in a proprietary product, please contact
sales@xwiki.com

