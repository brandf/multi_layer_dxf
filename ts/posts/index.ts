#!/usr/bin/env bun
// V3.6 post registry — the posts V3.6 ships (V3_SCOPE.md §6.2).
//
// One line per post. A new machine adds its module here and in
// the UI's post list (server/public/job-prep.js POSTS) — nothing
// else needs to know the post exists: the CLI driver
// (ts/gcode.ts) looks it up by id, the validator accepts any
// non-empty post_id string, and the round-trip verifier covers
// whatever the post emits within the parser's documented
// coverage (ts/gcode_parse.ts).

import { MASSO_INCH, MASSO_MM } from "./masso.ts";
import { GRBL } from "./grbl.ts";
import { TEMPLATE } from "./template.ts";
import { PostError } from "./common.ts";
import type { PostDef } from "./common.ts";

export const POSTS: Record<string, PostDef> = {
  "masso-mm": MASSO_MM,
  "masso-inch": MASSO_INCH,
  grbl: GRBL,
  template: TEMPLATE,
};

/** The default post: Brandon's machine, metric — the Foreman
 * runs the mm Masso post unless a job, a machine profile, or a
 * --post flag says otherwise (ts/gcode.ts resolution order). */
export const DEFAULT_POST_ID = "masso-mm";

export function listPosts(): { id: string; label: string; units: string; description: string }[] {
  return Object.values(POSTS).map((p) => ({
    id: p.id,
    label: p.label,
    units: p.units,
    description: p.description,
  }));
}

/** Look a post up by id. Unknown id -> `post_unknown` (named,
 * exit 1) — the CLI never guesses a post. */
export function getPost(id: string): PostDef {
  const post = POSTS[id];
  if (!post) {
    throw new PostError(
      "post_unknown",
      `unknown post-processor ${JSON.stringify(id)} — known posts: ${Object.keys(POSTS).join(", ")}`,
    );
  }
  return post;
}
