/**
 * Shared test helpers.
 *
 * ONE FUNCTION SO FAR, AND IT EXISTS BECAUSE THE SAME MISTAKE HAS BEEN MADE
 * FOUR TIMES.
 *
 * Every page on this site inlines the whole stylesheet into its <head>. That
 * makes assertions on the raw response lie in both directions:
 *
 *   POSITIVE — `out.includes('flagwrap')` is true on a page with no popup on
 *   it, because the CSS for popups is in the document. The accent pip shipped
 *   with styles and no element and every test passed.
 *
 *   NEGATIVE — `!out.includes('Turn off')` fails after the words are gone from
 *   every element, because they survive in a CSS comment explaining why they
 *   were removed. Same for "Newest hunters" and "gnote".
 *
 * So anything asserting about what the page SAYS goes through here, and
 * anything asserting that an ELEMENT exists matches on the tag rather than the
 * class name.
 */
export const bodyOf = (out) => out.slice(out.indexOf('</style>'));
