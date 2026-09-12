# VibeCode Harness — Lovable GitHub bridge

This repository uses either the institution-standard `gg_standard` profile or
the narrower `typescript_postgres` profile recorded in the project lock.

## Required build boundary

- Code created by Lovable: TypeScript (`.ts`, `.tsx`) only.
- PostgreSQL migrations: SQL only. Supabase migrations are supported when that integration is selected.
- Supabase Edge Functions, when used: TypeScript only.
- Do not add another backend runtime or an unreviewed package. In a
  `gg_standard` project, Python services are permitted only when their
  repository-level policy and PyPI dependency gate approve them.

## Lovable workflow

1. Connect the Lovable project to this GitHub repository.
2. Make Lovable edit a dedicated working branch, for example `lovable-work`.
3. Let the VibeCode GitHub workflow validate the branch.
4. Merge a passing pull request into `main`; do not use a direct production push.

Lovable project instructions are guidance inside Lovable. The repository policy
and GitHub pull-request gate are the enforcement boundary.
