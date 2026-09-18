#!/usr/bin/env bash
# Re-apply an upstream rewrite onto a block this fork moved to another file.
#
# Git sees "they rewrote it / we deleted it" and hands back the whole block on
# every merge. This replays upstream's diff onto the moved copy instead, so the
# only conflicts left are the places where the fork genuinely diverged.
#
#   ./scripts/remerge-moved-block.sh <conflicted-file> <hunk-index> <moved-copy> <first-line> <last-line>
#
# e.g. after a merge conflict in ws.ts whose second hunk is the bootstrap flow
# that now lives in TurnStartBootstrap.ts:
#
#   ./scripts/remerge-moved-block.sh apps/server/src/ws.ts 1 \
#     apps/server/src/orchestration/TurnStartBootstrap.ts \
#     'const dispatchTurnStart = (' 'return TurnStartBootstrap.of'
#
# It writes the merged block to stdout-adjacent files under a temp dir and
# prints where they are; splice the result in yourself and read every conflict
# it leaves. This automates the mechanical part, not the judgement.
set -euo pipefail

CONFLICTED=${1:?conflicted file}
HUNK=${2:?hunk index (0-based)}
MOVED=${3:?file holding the moved copy}
FIRST=${4:?first line of the moved copy}
LAST=${5:?last line of the moved copy}

# How the moved copy was adapted when it was extracted. Update these together
# with the extraction itself.
DEDENT=${DEDENT:-4}
RENAME_FROM=${RENAME_FROM:-dispatchFromClient(}
RENAME_TO=${RENAME_TO:-dispatch(}

WORK=$(mktemp -d)
python3 - "$CONFLICTED" "$HUNK" "$WORK" <<'PY'
import re, sys
from pathlib import Path
conflicted, hunk, work = sys.argv[1], int(sys.argv[2]), Path(sys.argv[3])
PAT = re.compile(
    r"^<<<<<<< [^\n]*\n(.*?)^\|\|\|\|\|\|\| [^\n]*\n(.*?)^=======\n(.*?)^>>>>>>> [^\n]*\n",
    re.S | re.M,
)
ms = list(PAT.finditer(Path(conflicted).read_text()))
if not ms:
    raise SystemExit(f"no diff3 conflicts in {conflicted} (is merge.conflictStyle diff3?)")
if hunk >= len(ms):
    raise SystemExit(f"hunk {hunk} out of range: {conflicted} has {len(ms)}")
(work / "base.txt").write_text(ms[hunk].group(2))
(work / "upstream.txt").write_text(ms[hunk].group(3))
print(f"hunk {hunk}: base {len(ms[hunk].group(2).splitlines())} lines, "
      f"upstream {len(ms[hunk].group(3).splitlines())} lines")
PY

for side in base upstream; do
  sed -e "s/^$(printf '%*s' "$DEDENT" '')//" \
      -e "s/${RENAME_FROM}/${RENAME_TO}/g" \
      "$WORK/$side.txt" > "$WORK/$side.norm"
done

sed -n "/${FIRST}/,/${LAST}/p" "$MOVED" > "$WORK/merged"
if [ ! -s "$WORK/merged" ]; then
  echo "found nothing between '${FIRST}' and '${LAST}' in ${MOVED}" >&2
  exit 1
fi

set +e
git merge-file -L ours -L base -L upstream --diff3 \
  "$WORK/merged" "$WORK/base.norm" "$WORK/upstream.norm"
CONFLICTS=$?
set -e

echo
echo "merged block: $WORK/merged"
echo "conflicts left: ${CONFLICTS}"
echo "Splice it back into ${MOVED} between '${FIRST}' and '${LAST}', resolve what remains,"
echo "then drop the hunk from ${CONFLICTED}. Re-run typecheck and the tests that cover it."
