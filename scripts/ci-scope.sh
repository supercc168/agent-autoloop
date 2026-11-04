#!/bin/sh
# Says how much CI a change needs, as scope=docs, normal or full. The slow simulations only cover kernel/, protocol/
# and sim/, so other code skips them on a PR, and text no test reads skips everything. A file this doesn't name, or
# a diff it can't get, means full; so does anything but pure text once it reaches main, in case a PR skipped too much.
set -u

case "${GITHUB_EVENT_NAME:-}" in
  pull_request) from=HEAD^1 ;;
  push) from=${BEFORE:-} ;;
  *) from="" ;;
esac

# Without --no-renames, moving a file out of kernel/ would show only where it landed.
if [ -z "$from" ] || ! files=$(git diff --no-renames --name-only "$from" HEAD 2>/dev/null) || [ -z "$files" ]; then
  echo "scope=full"
  exit 0
fi

scope=docs
while IFS= read -r file; do
  case "$file" in
    # The executable project-workflow contract test reads these public surfaces and fixtures.
    examples/recipes/project-workflow/* | plugins/lodestar/* | tests/project-workflow-*.test.ts | sim/project-workflow.test.ts) kind=normal ;;
    docs/protocol.md | docs/plugins.md | docs/architecture.svg | skills/agent-autoloop/SKILL.md) kind=normal ;;
    README.md | README.en.md | INSTALL.md | SECURITY.md) kind=normal ;;
    # tests/example-plugins.test.ts runs the commands in this tutorial.
    CONTRIBUTING.md | AGENTS.md | LICENSE) kind=docs ;;
    docs/* | .github/ISSUE_TEMPLATE/* | .github/pull_request_template.md) kind=docs ;;
    tests/simulation.test.ts) kind=full ;;
    plugins/* | examples/* | skills/* | worker/* | host/* | cli/* | bin/* | scripts/* | tests/* | install.sh) kind=normal ;;
    *) kind=full ;;
  esac
  case "$kind" in
    full) scope=full ;;
    normal) [ "$scope" = full ] || scope=normal ;;
  esac
done <<END
$files
END

if [ "$scope" = normal ] && [ "$GITHUB_EVENT_NAME" = push ]; then scope=full; fi
echo "scope=$scope"
