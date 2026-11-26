# bootleg-sync

[Device format 1](../../contracts/device_format.md) as a Rust library and CLI: pair SD cards and USB players, plan and apply add / mirror / fill syncs, and never touch files bootleg did not write.

Lives in bootleg-pod; the desktop bootleg app vendors this folder at `vendor/bootleg-sync` with `git subtree` (change it here, then pull it there). Keep it dependency-light: it also runs on the R36S.

```sh
cargo test -p bootleg-sync
cargo run -p bootleg-sync -- help
```
