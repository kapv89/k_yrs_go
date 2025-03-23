#!/bin/bash

serverdir="$(pwd)"
ycrdtdir="$serverdir/../y-crdt"

cd $ycrdtdir
ls
cargo build --release
cp $ycrdtdir/target/release/{libyrs.a,libyrs.so} $serverdir/db
cp $ycrdtdir/tests-ffi/include/libyrs.h $serverdir/db
cd $serverdir