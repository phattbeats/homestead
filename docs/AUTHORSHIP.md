# Authorship policy

Every Homestead commit must have the author identity `phattbeats <obiwouldjablowme@protonmail.com>` and must contain no `Co-authored-by` trailer, regardless of its name or email. Configure a clone with `git config user.name phattbeats` and `git config user.email obiwouldjablowme@protonmail.com`, then run `npm run hooks:install` (or `npm install`, which runs it automatically). In Claude Code, set `includeCoAuthoredBy` to `false` in user or project `settings.json`; OpenClaw/Paperclip commit paths follow the same rule.
