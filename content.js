(function () {
  'use strict';

  // ── Click all visible "See More" buttons to expand truncated post text ──────
  function expandSeeMore() {
    const candidates = document.querySelectorAll('div[role="button"], span[role="button"]');
    for (const el of candidates) {
      const text = el.textContent?.trim();
      if (text === 'See more' || text === 'See More') {
        try { el.click(); } catch (_) {}
      }
    }
  }

  // ── Derive group name from page ───────────────────────────────────────────
  function getGroupName() {
    // Try the main heading first, then fall back to og:title or document title
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent.trim()) return h1.textContent.trim();

    const og = document.querySelector('meta[property="og:title"]');
    if (og) return og.content.replace(/ \| Facebook$/, '').trim();

    return document.title.replace(/ \| Facebook$/, '').trim();
  }

  // ── Extract posts from the page ──────────────────────────────────────────
  function extractPosts() {
    const groupName = getGroupName();
    const posts     = [];
    const seen      = new Set();

    const articles = document.querySelectorAll('[role="article"]');

    for (const article of articles) {
      try {
        // ── Post URL ────────────────────────────────────────────────────────
        let postUrl = '';
        const links = article.querySelectorAll('a[href]');
        for (const link of links) {
          const href = link.href || '';
          if (
            /\/groups\/[^/]+\/(permalink|posts)\/\d+/.test(href) ||
            /\/groups\/\d+\/(permalink|posts)\/\d+/.test(href)
          ) {
            postUrl = href.split('?')[0]; // strip query string
            break;
          }
        }

        // Skip articles that don't look like group posts (ads, suggestions, etc.)
        if (!postUrl) continue;
        if (seen.has(postUrl)) continue;
        seen.add(postUrl);

        // ── Poster name ─────────────────────────────────────────────────────
        let posterName = '';
        // Try: <h3> or <h4> link text (common in group post headers)
        const nameEl =
          article.querySelector('h3 a, h4 a') ||
          article.querySelector('a[href*="/user/"] strong, a[href*="/profile.php"] strong') ||
          article.querySelector('strong');
        if (nameEl) posterName = nameEl.textContent.trim();

        // ── Post text ───────────────────────────────────────────────────────
        // Facebook puts post body in div[dir="auto"] elements. The longest one
        // inside the article is typically the post text.
        let postText = '';
        const textEls = article.querySelectorAll('[dir="auto"]');
        for (const el of textEls) {
          const text = el.textContent.trim();
          if (text.length > postText.length) postText = text;
        }

        // ── Timestamp ───────────────────────────────────────────────────────
        let postedAt = '';
        // Older FB used abbr[data-utime]; newer uses aria-label timestamps on links
        const timeEl = article.querySelector('abbr[data-utime]');
        if (timeEl) {
          const utime = parseInt(timeEl.getAttribute('data-utime'), 10);
          if (!isNaN(utime)) postedAt = new Date(utime * 1000).toISOString();
        }
        if (!postedAt) {
          // Try <a> elements whose aria-label contains a date/time string
          for (const a of links) {
            const label = a.getAttribute('aria-label') || '';
            if (/\d{4}|\bam\b|\bpm\b|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(label)) {
              // We have a human-readable timestamp but not a parseable one; leave postedAt empty
              // so last_run filtering falls back to including the post.
              break;
            }
          }
        }

        posts.push({ posterName, postText, postUrl, postedAt, groupName });
      } catch (_) {
        // Malformed article — skip silently
      }
    }

    return posts;
  }

  // ── Main ─────────────────────────────────────────────────────────────────
  async function main() {
    try {
      // First pass: expand truncated posts
      expandSeeMore();

      // Single micro-scroll to trigger lazy-loaded content
      window.scrollBy(0, 500);
      await new Promise(r => setTimeout(r, 1500));

      // Second pass after scroll
      expandSeeMore();

      const posts = extractPosts();

      chrome.runtime.sendMessage({ type: 'POSTS_RESULT', posts });
    } catch (err) {
      chrome.runtime.sendMessage({ type: 'POSTS_RESULT', posts: [], error: err.message });
    }
  }

  main();
})();
