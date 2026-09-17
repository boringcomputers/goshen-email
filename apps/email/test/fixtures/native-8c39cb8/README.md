# Native schema fixture

These two TypeScript files are unchanged copies from
[`boringcomputers/bezalel` at `8c39cb800b951b6708bf197927957cad09e8f0e3`](https://github.com/boringcomputers/bezalel/tree/8c39cb800b951b6708bf197927957cad09e8f0e3/apps/email/src).
The native Worker deployed on September 11, 2026 uses this revision.
They retain the source repository's AGPL-3.0-only license.

Keep this fixture frozen. The migration test starts with this schema and
synthetic mail, then applies the candidate schema twice. It compares every
original column in every original table before exercising existing credentials,
attachments, send reservations, and webhook retries. No production mail or
credentials belong here.
