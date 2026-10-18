# Homestead devlog

A seven-part series on how Homestead was built, from the first single-container release to the
v0.6.0 fresh start. Drafts: nothing here is published yet.

| Part | Post | About |
| --- | --- | --- |
| 1 | [The pitch. One container, two people, take turns.](posts/devlog-01.md) | v0.0.1, take-turns chores, the iframe shell and escape dot, one SQLite file |
| 2 | [The front door](posts/devlog-02.md) | Logins, invites, Authentik single sign-on, owner recovery, session secrets |
| 3 | [The Porch: a feed, then rooms](posts/devlog-03.md) | The Porch wall, modular rooms, notifications, shared lists, live updates |
| 4 | [Calendars and libraries](posts/devlog-04.md) | CalDAV and Microsoft 365 sources, the merge layer, Plex/Kavita and the entity graph |
| 5 | [Agents move in](posts/devlog-05.md) | Personal access tokens, Hearth, companion pairing, the third-party app contract |
| 6 | [The Gazette, the brand, and the Forum](posts/devlog-06.md) | The daily Gazette, the brand system, the v0.6.0 Forum |
| 7 | [How a pile of agents built a house app](posts/devlog-07.md) | Definition of Done, test and deploy failures, GitHub gotchas, the fresh start |

## Layout

- `posts/devlog-NN.md`: one post each. The header block (`title`, `slug`, `excerpt`, `tags`,
  `feature_image`, `publish`) maps to the blog's post settings; the body is Markdown.
- `img/`: screenshots from a local demo instance (fake data, users `alex` and `sam`) and brand art.
- `diagrams/`: hand-written SVG figures, referenced as `FIG N-k` in the captions.
- `preview/`: static HTML renders of each post for review. Open `preview/index.html` from a
  checkout; images load by relative path.
