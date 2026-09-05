// Porch media-comprehension package (PHA-2844, closing the PHA-2827.E
// gap PHA-2636 left open).
//
// lib/porch/sweep.js decides WHEN an agent should consider a post;
// lib/porch/participation-contract.js decides WHETHER a candidate
// clears the anti-lame gates once one exists. Neither has ever built
// the candidate's raw material — the `{ frames, captionNames,
// graphEntities, pastReactionRefs }` shape participation-contract.js's
// `hasSpecificity`/`evaluateCandidate` reads. This module is that
// missing piece: given a wall post, produce that shape for real.
//
//   * image/video posts — reuse lib/media.js's `buildContext` (already
//     does ffmpeg keyframe extraction + whisper transcription and
//     caches by source mtime) for frames/transcript, then run a
//     vision-capable LLM call over the frames to turn pixels into
//     short, quotable descriptions. The LLM call is a test seam
//     (`__test__.setFrameDescriber`) — same pattern as lib/agent-
//     runtime.js's `__test__.setSystemPromptLoader` — so tests don't
//     need real network/vision access to exercise the pipeline.
//   * text-only posts — no frames to describe; captionNames/
//     graphEntities are derived straight from the post text with a
//     cheap heuristic (significant words + capitalized phrases). No
//     LLM call needed or made — a text post's "concrete details" ARE
//     its text.
//   * pastReactionRefs — read (never reinvented) from lib/porch/
//     participation-contract.js's existing banter-memory table via
//     `recentReactionTexts`, scoped to the same wall.
//
// A vision call failure (no key, network, bad JSON) degrades to the
// text-derived fallback rather than throwing — same "silence over
// fabrication" posture as the rest of the Porch stack. This module
// never talks to porch_agent_reactions for writes and never posts
// anything; server.js's onDecision is the only caller that turns its
// output into an actual comment.
//
// Pure-ish logic (one LLM call for media posts) — no HTTP, no
// express. Imported by:
//   * server.js (onDecision, PHA-2844)
//   * scripts/test-2827d-porch-integration.js

'use strict';

const path = require('path');
const fs = require('fs');

const media = require('../media');
const porchContract = require('./participation-contract');
const agentRuntime = require('../agent-runtime');

// ---- Text-derived fallback (also the whole story for text posts) ----

const STOPWORDS = new Set([
  'the', 'and', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'is', 'it',
  'this', 'that', 'with', 'was', 'were', 'be', 'been', 'are', 'at',
  'as', 'but', 'or', 'so', 'we', 'you', 'i', 'my', 'me', 'our', 'us',
  'just', 'not', 'have', 'has', 'had', 'will', 'would', 'can', 'did',
  'do', 'does', 'up', 'out', 'if', 'from', 'by', 'her', 'his', 'their',
  'its', 'they', 'them', 'he', 'she', 'im', 'about',
]);

function tokenizeWords(text) {
  return String(text || '').split(/[^A-Za-z0-9']+/).filter(Boolean);
}

// deriveFromText(text): no LLM, no network — a text post's concrete
// details are just its own significant words. `captionNames` gets the
// lowercase significant words (the specificity gate normalizes to
// lowercase anyway); `graphEntities` gets capitalized multi-letter
// words/phrases (a cheap proper-noun heuristic — "Emily", "Popcorn
// Vote") since those are the tokens most likely to be a person/thing
// name a candidate would want to reference by name.
function deriveFromText(text) {
  const words = tokenizeWords(text);
  const significant = words.filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));
  const properNouns = [];
  for (let i = 0; i < words.length; i++) {
    if (/^[A-Z][a-z]{2,}$/.test(words[i])) {
      // Greedily join adjacent capitalized words into one phrase
      // ("Popcorn Vote") rather than two disconnected single-word refs.
      let phrase = words[i];
      let j = i + 1;
      while (j < words.length && /^[A-Z][a-z]{2,}$/.test(words[j])) {
        phrase += ' ' + words[j];
        j++;
      }
      properNouns.push(phrase);
      i = j - 1;
    }
  }
  const captionNames = Array.from(new Set(significant.map((w) => w.toLowerCase()))).slice(0, 12);
  const graphEntities = Array.from(new Set(properNouns.map((w) => w.toLowerCase()))).slice(0, 8);
  return { captionNames, graphEntities };
}

// ---- Vision description (frames/images -> captions/entities) ----

const VISION_SYSTEM_PROMPT =
  "You are Hearth's eyes for the Homestead Porch. You'll be shown one or " +
  'more frames from a household post plus its caption text. Describe ONLY ' +
  "what's concretely visible — specific objects, people's visible actions, " +
  'settings, text-on-screen. No vibes, no guessing at feelings. Reply with ' +
  'strict JSON only, no prose, no markdown fences: ' +
  '{"frames": ["short phrase per frame, same order"], ' +
  '"captionNames": ["short concrete labels"], ' +
  '"graphEntities": ["named people/places/things if any, else []"]}';

function extToMime(absPath) {
  const ext = path.extname(absPath).slice(1).toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

function toDataUrl(absPath) {
  const buf = fs.readFileSync(absPath);
  return `data:${extToMime(absPath)};base64,${buf.toString('base64')}`;
}

function parseVisionJson(text) {
  try {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    const obj = JSON.parse(match ? match[0] : text);
    return {
      frames: Array.isArray(obj.frames) ? obj.frames.map(String) : [],
      captionNames: Array.isArray(obj.captionNames) ? obj.captionNames.map(String) : [],
      graphEntities: Array.isArray(obj.graphEntities) ? obj.graphEntities.map(String) : [],
    };
  } catch (e) {
    return { frames: [], captionNames: [], graphEntities: [] };
  }
}

// defaultDescribeFrames({ imagePaths, postText, byokKey, providerCfg }):
// production implementation — routes through lib/agent-runtime.js's
// provider plumbing (same BYOK-first/server-staged-fallback key
// resolution dispatchHearth uses) with a multimodal message. Any
// failure (no key, network, unparseable reply) returns empty arrays
// rather than throwing — the caller's text-derived fallback still
// applies on top.
async function defaultDescribeFrames({ imagePaths, postText, byokKey, providerCfg } = {}) {
  if (!imagePaths || !imagePaths.length) return { frames: [], captionNames: [], graphEntities: [] };

  let cfg = providerCfg;
  if (!cfg) {
    const provider = process.env.HEARTH_PROVIDER || 'litellm';
    const baseUrl = agentRuntime.pickServerStagedBaseUrl(provider);
    const model = agentRuntime.pickServerStagedModel(provider);
    const key = agentRuntime.resolveKey({ provider, byokKey });
    if (!key.apiKey) return { frames: [], captionNames: [], graphEntities: [] };
    cfg = { provider, baseUrl, apiKey: key.apiKey, model };
  }

  let providerObj;
  try {
    providerObj = agentRuntime.createProvider({
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      maxTokens: cfg.maxTokens || 512,
      system: VISION_SYSTEM_PROMPT,
      fetchImpl: cfg.fetchImpl,
    });
  } catch (e) {
    return { frames: [], captionNames: [], graphEntities: [] };
  }

  const content = [
    { type: 'text', text: `Post text: ${postText || '(none)'}` },
    ...imagePaths.map((p) => ({ type: 'image_url', image_url: { url: toDataUrl(p) } })),
  ];

  let fullText = '';
  try {
    for await (const ev of providerObj.stream([{ role: 'user', content }])) {
      if (ev.type === 'text') fullText += ev.text;
      else if (ev.type === 'error') return { frames: [], captionNames: [], graphEntities: [] };
    }
  } catch (e) {
    return { frames: [], captionNames: [], graphEntities: [] };
  }

  return parseVisionJson(fullText);
}

let _describeFrames = defaultDescribeFrames;

// imagePathsFor(mediaId, pkg): absolute file paths to hand the vision
// call. An image post is one frame (the original file); a video post
// is its extracted keyframes. `pkg` is media.buildContext's already-
// built comprehension package (frames array + kind), so this does no
// extra ffmpeg work of its own.
function imagePathsFor(mediaId, pkg) {
  if (pkg.kind === 'image') {
    const abs = media.originalAbsPath(mediaId);
    return abs ? [abs] : [];
  }
  if (pkg.kind === 'video') {
    return (pkg.frames || []).map((f) => media.frameAbsPath(mediaId, f.url));
  }
  return [];
}

function dedupe(arr) {
  return Array.from(new Set(arr));
}

// buildComprehension(db, { post, agentUserId, byokKey, providerCfg }):
// `post` is a full wall_posts row (kind, media_id, text_body, wall_id).
// Returns the `{ frames, captionNames, graphEntities, pastReactionRefs }`
// shape lib/porch/participation-contract.js's decide() expects.
async function buildComprehension(db, opts = {}) {
  const { post, agentUserId, byokKey, providerCfg } = opts;
  if (!post) throw new Error('comprehension: post is required');

  const pastReactionRefs = porchContract.recentReactionTexts(db, agentUserId, { wallId: post.wall_id });

  const isMediaPost = (post.kind === 'image' || post.kind === 'video') && !!post.media_id;
  if (!isMediaPost) {
    const derived = deriveFromText(post.text_body || '');
    return { frames: [], captionNames: derived.captionNames, graphEntities: derived.graphEntities, pastReactionRefs };
  }

  let pkg;
  try {
    pkg = await media.buildContext(post.media_id, { byokKey });
  } catch (e) {
    pkg = { error: 'build_failed' };
  }
  if (!pkg || pkg.error) {
    // Media unreadable/deleted — fall back to whatever the post's own
    // text says rather than returning an empty comprehension package.
    const derived = deriveFromText(post.text_body || '');
    return { frames: [], captionNames: derived.captionNames, graphEntities: derived.graphEntities, pastReactionRefs };
  }

  const imagePaths = imagePathsFor(post.media_id, pkg);
  const described = await _describeFrames({ imagePaths, postText: post.text_body, byokKey, providerCfg });
  const textDerived = deriveFromText([post.text_body, pkg.caption, pkg.audioTranscript].filter(Boolean).join(' '));

  return {
    frames: described.frames,
    captionNames: dedupe([...described.captionNames, ...textDerived.captionNames]),
    graphEntities: dedupe([...described.graphEntities, ...textDerived.graphEntities]),
    pastReactionRefs,
  };
}

module.exports = {
  buildComprehension,
  deriveFromText,
  __test__: {
    setFrameDescriber(fn) { _describeFrames = fn; },
    resetFrameDescriber() { _describeFrames = defaultDescribeFrames; },
    imagePathsFor,
  },
};
