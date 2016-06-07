# chainpad-netflux
A convenient wrapper around the chainpad realtime engine and the netflux transport API

## Usage

Use chainpad-netflux in conjunction with a [chainpad server](http://github.com/xwiki-labs/chainpad-server), requirejs, and any combination of a [growing number of chainpad-related modules](https://github.com/xwiki-labs/realtime-handbook/blob/master/REPOSITORIES.md).

```javascript
define([
    '/api/config?cb=' + Math.random().toString(16).slice(2),
    '/bower_components/chainpad-netflux/chainpad-netflux.js',
    '/bower_components/textpatcher/TextPatcher.js',
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


## Installation

`bower install chainpad-netflux`

## License

This software is and will always be available under the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the License, or (at your option)
any later version. If you wish to use this technology in a proprietary product, please contact
sales@xwiki.com

