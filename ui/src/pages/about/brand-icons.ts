import { html } from "lit";
import { githubMark } from "../../components/github-mark.ts";

// Solid brand marks stay separate from the stroked lucide `icons` set.
// GitHub is shared with the reader tabs; about.css targets .icon--filled.
export const brandIcons = {
  github: githubMark,
  x: html`
    <svg viewBox="0 0 24 24" class="icon--filled">
      <path
        d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.67l7.73-8.84L1.25 2.25h6.83l4.71 6.23Zm-1.16 17.52h1.83L7.08 4.13H5.12Z"
      />
    </svg>
  `,
} as const;
