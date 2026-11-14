#!/usr/bin/env bash
# 测试书用的隔离环境：起、复位、关。底层是仓库里的 pi-web-client-test-dev 技能。
#
#   bash .pi/skills/pi-web-test-html/bin/env.sh up    <仓库目录> [实例名]
#   bash .pi/skills/pi-web-test-html/bin/env.sh fresh <仓库目录> [实例名] [用例集]
#   bash .pi/skills/pi-web-test-html/bin/env.sh down  [实例名]
#
# fresh = 关掉 → 跑该用例集的模块清理（setup/<用例集>.sh）→ 删该实例状态目录 → 重起，
# 让「首次打开」类断言每次都在干净状态下成立。不做 fresh 就只起一份现成环境。
set -euo pipefail

SKILL_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENV_MJS="$(cd "$SKILL_DIR/../pi-web-client-test-dev" && pwd)/bin/env.mjs"
STATE_ROOT="${HOME:-$USERPROFILE}/.pi/agent/state/pi-web-test-dev"

cmd=${1:-up}
repo=${2:-$(pwd)}
id=${3:-wk}
case_name=${4:-workclock}

case "$cmd" in
  up)
    node "$ENV_MJS" start --dir "$repo" --name "$id" 2>&1 | tail -8
    ;;
  fresh)
    node "$ENV_MJS" stop --id "$id" >/dev/null 2>&1 || true
    if [ -f "$SKILL_DIR/setup/$case_name.sh" ]; then
      bash "$SKILL_DIR/setup/$case_name.sh" >/dev/null 2>&1 || true
    fi
    rm -rf "$STATE_ROOT/$id/bridge/$case_name"
    node "$ENV_MJS" start --dir "$repo" --name "$id" 2>&1 | tail -8
    ;;
  down)
    node "$ENV_MJS" stop --id "$id" 2>&1 | tail -3
    ;;
  *)
    echo "用法：env.sh up|fresh|down <仓库目录> [实例名] [用例集]" >&2
    exit 2
    ;;
esac
