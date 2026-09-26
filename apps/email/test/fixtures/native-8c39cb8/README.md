# Native schema fixture

These two TypeScript files are unchanged copies of `apps/email/src` from
`boringcomputers/bezalel`, a private repository, at commit
`8c39cb800b951b6708bf197927957cad09e8f0e3`.
The native Worker deployed on September 11, 2026 uses this revision.
Like the other extracted files, they carry this repository's FSL-1.1-ALv2 license.

Keep this fixture frozen. The migration test starts with this schema and
synthetic mail, then applies the candidate schema twice. It compares every
original column in every original table before exercising existing credentials,
attachments, send reservations, and webhook retries. No production mail or
credentials belong here.
