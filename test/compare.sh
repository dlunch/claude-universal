#!/bin/sh
# End-to-end test against a mock Messages API (test/mock-api.mjs): the model asks for a Bash
# tool call and answers with its output. Checks that headless runs and background sessions of
# both images reach the expected answer, and that an interactive session renders the same
# screen in both.
#
#   test/compare.sh <reference-image> <image>
set -eu

cd "$(dirname "$0")"
NETWORK="claude-test-$$"
MOCK="claude-mock-$$"
EXPECTED='The command printed: tool-ran-42'
# The key is approved in the config by its last 20 characters.
KEY=sk-ant-api03-mock-0000000000000000000000
CONFIG='{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true,"customApiKeyResponses":{"approved":["00000000000000000000"]},"projects":{"/workspace":{"hasTrustDialogAccepted":true}}}'

docker network create "$NETWORK" >/dev/null
trap 'docker rm -f "$MOCK" >/dev/null; docker network rm "$NETWORK" >/dev/null' EXIT
docker run -d --name "$MOCK" --network "$NETWORK" -v "$PWD:/test:ro" node:22-bookworm-slim node /test/mock-api.mjs >/dev/null

claude() { # docker options..., image, claude arguments...
  docker run --rm --network "$NETWORK" -e ANTHROPIC_API_KEY="$KEY" -e ANTHROPIC_BASE_URL="http://$MOCK:8080" \
    --entrypoint sh "$@"
}

headless() {
  claude "$1" -c 'echo "$0" > ~/.claude.json && exec claude --dangerously-skip-permissions -p RUN_TOOL' "$CONFIG"
}

# Starts a background session, which runs on a pseudo-terminal, and prints its terminal
# output once it contains the answer.
background() {
  claude "$1" -c '
    echo "$0" > ~/.claude.json
    timeout -k 5 180 claude --bg --dangerously-skip-permissions RUN_TOOL > /tmp/bg.out 2>&1
    id=$(sed -n "s/^backgrounded · //p" /tmp/bg.out)
    for i in $(seq 180); do
      [ -n "$id" ] || break
      timeout -k 5 30 claude logs "$id" | grep -q tool-ran-42 && echo "$1" && exit
      sleep 1
    done
    # Diagnostics for a session that did not answer.
    cat /tmp/bg.out
    [ -n "$id" ] && timeout -k 5 30 claude logs "$id"
    for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline"; echo; done
    tail -n 30 /tmp/cc-daemon-*/stderr.log' "$CONFIG" "$EXPECTED"
}

interactive() {
  session="claude-test-$$-$(echo "$1" | tr -c 'a-z0-9' -)"
  tmux new-session -d -s "$session" -x 100 -y 30 docker run --rm -it --name "$session" --network "$NETWORK" \
    -e ANTHROPIC_API_KEY="$KEY" -e ANTHROPIC_BASE_URL="http://$MOCK:8080" --entrypoint sh "$1" \
    -c 'echo "$0" > ~/.claude.json && exec claude --dangerously-skip-permissions' "$CONFIG"
  wait_for "$session" '^❯' || return 1
  tmux send-keys -t "$session" -l 'wide 한글 😀 👨‍👩‍👧 RUN_TOOL'
  tmux send-keys -t "$session" Enter
  wait_for "$session" "$EXPECTED" || return 1
  screen=
  until [ "$screen" = "${previous-}" ]; do
    previous=$screen
    sleep 5
    screen=$(capture "$session")
  done
  echo "$screen"
  stop "$session"
}

# Drops what depends on timing: the completion line names a random verb, the duration and
# the time of day, and the effort indicator appears whenever its lookup finishes.
capture() { # session
  tmux capture-pane -e -p -t "$1" \
    | sed -E -e 's/[A-Z][a-z]+ for [0-9]+s · done [0-9:]+ [AP]M/(done)/' -e '/\/effort/s/.*//'
}

stop() { # session
  tmux kill-session -t "$1"
  docker rm -f "$1" >/dev/null
}

wait_for() { # session, pattern
  i=0
  until tmux capture-pane -p -t "$1" | grep -q "$2"; do
    i=$((i + 1))
    if [ "$i" -gt 180 ]; then
      tmux capture-pane -p -t "$1" >&2
      stop "$1"
      echo "timed out waiting for: $2" >&2
      return 1
    fi
    sleep 1
  done
}

status=0
for image in "$1" "$2"; do
  for mode in headless background; do
    output=$($mode "$image")
    if [ "$output" = "$EXPECTED" ]; then
      echo "$image $mode: ok"
    else
      printf '%s %s: unexpected output\n%s\n' "$image" "$mode" "$output" >&2
      status=1
    fi
  done
done

expected=$(interactive "$1")
actual=$(interactive "$2")
if [ "$expected" = "$actual" ]; then
  echo "interactive: identical"
else
  echo "interactive: screens differ" >&2
  printf '%s\n' "$expected" > /tmp/expected.txt
  printf '%s\n' "$actual" > /tmp/actual.txt
  diff /tmp/expected.txt /tmp/actual.txt >&2 || true
  status=1
fi
exit $status
