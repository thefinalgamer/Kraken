/*
 * Kraken on Twitch — the broadcaster's setup page.
 *
 * ITS ONLY JOB IS TO LEARN ONE NAME. The panel needs to know whose board to
 * show, and Twitch's own configuration service is where that belongs: it is
 * per-channel, it is delivered to the panel without a request, and it survives
 * without Kraken storing a single thing about a Twitch account.
 *
 * THE NAME IS CHECKED BEFORE IT IS SAVED. A typo that saves cleanly costs the
 * broadcaster an empty panel in front of their viewers and no clue why, so this
 * asks the board first and refuses anything it does not recognise. That one
 * round trip is the difference between a setup page and a text box.
 *
 * No inline JavaScript, same as the panel: Twitch drops it.
 */
(function () {
  'use strict';

  var API = 'https://platinumintel.co.uk/api/hunter/';

  var $ = function (id) { return document.getElementById(id); };
  var input, msg, save, clear;

  function say(text, kind) {
    msg.textContent = text;
    msg.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function store(psn) {
    /* Segment "broadcaster", version "1". The panel reads exactly this. */
    window.Twitch.ext.configuration.set('broadcaster', '1', JSON.stringify({ psn: psn }));
  }

  function current() {
    var seg = window.Twitch.ext.configuration.broadcaster;
    if (!seg || !seg.content) return '';
    try {
      var p = JSON.parse(seg.content);
      return p && typeof p.psn === 'string' ? p.psn : '';
    } catch (e) {
      return '';
    }
  }

  function onSave() {
    var psn = input.value.trim();
    if (!psn) { say('Type your PSN ID first.', 'bad'); return; }

    save.disabled = true;
    say('Checking the board…');

    fetch(API + encodeURIComponent(psn), { method: 'GET' })
      .then(function (res) {
        if (res.status === 404) throw new Error('unknown');
        if (!res.ok) throw new Error('http');
        return res.json();
      })
      .then(function (data) {
        /*
         * Saved as the board spells it, not as it was typed. PSN ids are
         * case-carrying and the panel prints this straight back at viewers.
         */
        var exact = (data && data.hunter && data.hunter.name) || psn;
        input.value = exact;
        store(exact);
        say('Saved. ' + exact + ' is ' + data.hunter.rank + ' of ' + data.hunter.of
          + ' on the board. Your panel updates within a minute.', 'ok');
      })
      .catch(function (err) {
        if (String(err.message) === 'unknown') {
          say('“' + psn + '” is not a registered hunter. Check the spelling against your '
            + 'hunter page on platinumintel.co.uk, or run /register in Discord first.', 'bad');
        } else {
          say('Could not reach the board just now. Try again in a moment.', 'bad');
        }
      })
      .then(function () { save.disabled = false; });
  }

  function onClear() {
    input.value = '';
    store('');
    say('Cleared. The panel will ask to be set up again.', 'ok');
  }

  document.addEventListener('DOMContentLoaded', function () {
    input = $('psn');
    msg = $('msg');
    save = $('save');
    clear = $('clear');

    save.addEventListener('click', onSave);
    clear.addEventListener('click', onClear);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') onSave();
    });

    if (!window.Twitch || !window.Twitch.ext) {
      say('This page only works inside the Twitch extension settings.', 'bad');
      save.disabled = true;
      clear.disabled = true;
      return;
    }

    window.Twitch.ext.onAuthorized(function () {
      var was = current();
      if (was) {
        input.value = was;
        say('Currently showing ' + was + '.');
      }
    });
  });
})();
