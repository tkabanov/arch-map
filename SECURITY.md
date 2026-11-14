# Security

Please report a vulnerability privately through GitHub's **Report a vulnerability** button on the repository's
Security tab, not in a public issue. Include what is affected, how to reproduce it and the impact you see.

Relevant areas: the viewer renders spec documents it is given (`mount()` in `docs/embedding.md`), and the generators
read target codebases and committed snapshots, which must never contain secrets.

Fixes go into the latest release.
