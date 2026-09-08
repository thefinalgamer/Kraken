/*
 * Kraken on Twitch — the broadcaster's settings page.
 *
 * THERE IS NOTHING TO CONFIGURE, AND THAT IS THE FEATURE.
 *
 * The first version of this page asked the broadcaster to type a PSN ID. That
 * was a hole: nothing stopped them typing somebody else's, and the setting
 * lived in Twitch's configuration service where Kraken could neither see it nor
 * clear it. Martin, the first time he looked at it: "what happens if i picked
 * someone else id, can i remove it on my end to stop grief". The answer was no.
 *
 * So the panel now identifies the hunter from the channel it is running on -
 * something a broadcaster cannot forge - and this page's only job is to tell
 * them whether that channel is linked, and how to link it if not.
 *
 * The fix removed a feature rather than adding one. There is no text box left
 * to abuse, and one less thing for a streamer to get wrong at midnight.
 *
 * No inline JavaScript, same as the panel: Twitch drops it.
 */
(function () {
  'use strict';

  var CHANNEL = 'https://platinumintel.co.uk/api/channel/';
  var SITE = 'https://platinumintel.co.uk';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function show(box, label, line, link) {
    box.textContent = '';
    box.appendChild(el('span', 'lbl', label));
    box.appendChild(el('p', 'muted', line));
    if (link) {
      var a = el('a', 'btn', 'Open their hunter page ›');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.marginTop = '10px';
      box.appendChild(a);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var box = document.getElementById('status');

    if (!window.Twitch || !window.Twitch.ext) {
      show(box, 'Not on Twitch', 'This page only works inside the extension settings.');
      return;
    }

    window.Twitch.ext.onAuthorized(function (auth) {
      var channel = auth && auth.channelId;
      if (!channel) {
        show(box, 'Cannot read this channel', 'Try reloading the page.');
        return;
      }

      fetch(CHANNEL + encodeURIComponent(channel), { method: 'GET' })
        .then(function (res) {
          if (res.status === 404) throw new Error('unlinked');
          if (!res.ok) throw new Error('http');
          return res.json();
        })
        .then(function (body) {
          if (!body || !body.hunter) throw new Error('unlinked');
          show(
            box,
            'This channel is linked',
            'The panel is showing ' + body.hunter + '.',
            SITE + '/hunter/' + encodeURIComponent(body.hunter),
          );
        })
        .catch(function (err) {
          if (String(err.message) === 'unlinked') {
            show(box, 'Not linked yet',
              'No hunter has claimed this channel. Run /twitch in the Platinum Intel '
              + 'Discord with your channel name, then reload this page.');
          } else {
            show(box, 'Could not reach the board', 'Try again in a moment.');
          }
        });
    });
  });
})();
