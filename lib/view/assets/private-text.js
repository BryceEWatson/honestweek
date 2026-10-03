// "Show private text", on this machine only. When the switch is on, a page asks the server for
// its private build (names, client words and folders that redaction would hide; keys, tokens
// and passwords stay hidden either way). That text is built in the server's memory, never saved,
// and reaches only this tab. The run key and the switch's storage live in key.js; this file is
// the page's handle on them. Needs key.js loaded first.
(function () {
  'use strict';
  const client = window.HWKey.createKeyClient();
  const ready = client.init();
  window.HWP = {
    client,
    /** Resolves to this tab's key state: "ready", "no-key", "stale" or "stopped". */
    ready,
    get key() {
      return client.key;
    },
    /** Whether the switch is on for this run, read once when the page loaded. */
    get on() {
      return client.on;
    },
    get state() {
      return client.state;
    },
    /** What the switch promises, in the words every page uses. */
    promise: "Private text is built in this program's memory and never saved. This tab remembers the switch until honestweek view stops.",
    api: (route, params, opts) => client.api(route, params, opts),
    notice: (state) => window.HWKey.NOTICE[state] ?? '',
    /** Save the switch for this run without reloading (the click-through test sets it this way). */
    store: (value) => client.storeSwitch(value),
    /** The saved switch for this run, read again (another frame may have changed it). */
    read: () => client.readSwitch(),
    /** Turn the switch on or off and reload the page in that mode. */
    set(value) {
      if (value !== true && typeof window.HWP.beforeOff === 'function') window.HWP.beforeOff();
      client.storeSwitch(value === true);
      location.reload();
    },
    /** A page's hook for turning the switch off: drop anything private before the reload. */
    beforeOff: null,
  };
})();
