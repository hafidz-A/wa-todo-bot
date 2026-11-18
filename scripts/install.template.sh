#!/usr/bin/env bash
# Pasang / perbarui bot WhatsApp to-do di VPS (Ubuntu/Debian).
# Aman dijalankan berulang: data dan .env yang sudah ada tidak ditimpa.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/wa-todo-bot}"
APP_NAME="wa-todo-bot"

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*"; exit 1; }
ask()  { local __v; read -r -p "    $1 " __v <&3 || true; printf '%s' "$__v"; }
ask_secret() { local __v; read -r -s -p "    $1 " __v <&3 || true; echo >"${TTY_OUT}"; printf '%s' "$__v"; }

TTY="${INSTALL_TTY:-/dev/tty}"; TTY_OUT="/dev/tty"; [ -n "${INSTALL_TTY:-}" ] && TTY_OUT=/dev/stderr
exec 3<"$TTY" || { echo "Jalankan skrip ini dari terminal/konsol interaktif."; exit 1; }
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || die "Jalankan sebagai root atau pasang sudo dulu."
  SUDO="sudo"
fi

# ---------------------------------------------------------------- 1. alat
say "1/7 Memeriksa Node.js, alat build, dan pm2"
if ! command -v apt-get >/dev/null; then die "Skrip ini untuk Ubuntu/Debian (apt-get tidak ditemukan)."; fi
NODE_OK=0
if command -v node >/dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 22 ] && NODE_OK=1
fi
if [ "$NODE_OK" -ne 1 ]; then
  info "Memasang Node.js 22…"
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq curl ca-certificates >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - >/dev/null
  $SUDO apt-get install -y -qq nodejs >/dev/null
fi
info "Node.js $(node -v)"
if ! command -v g++ >/dev/null || ! command -v make >/dev/null; then
  info "Memasang alat build (untuk SQLite)…"
  $SUDO apt-get install -y -qq build-essential python3 >/dev/null
fi
if ! command -v pm2 >/dev/null; then
  info "Memasang pm2…"
  $SUDO npm install -g pm2 --silent >/dev/null
fi
pm2 ping >/dev/null 2>&1 || true
info "pm2 $(pm2 -v 2>/dev/null | tail -n1)"

# ---------------------------------------------------------------- 2. kode
say "2/7 Memasang kode bot ke $APP_DIR"
$SUDO mkdir -p "$APP_DIR"
$SUDO chown "$(id -u):$(id -g)" "$APP_DIR"
base64 -d <<'__PAYLOAD_END__' | tar -xz -C "$APP_DIR"
__PAYLOAD__
__PAYLOAD_END__
info "Kode terpasang."

# ---------------------------------------------------------------- 3. bot lama
say "3/7 Mencari bot lama yang sedang berjalan"
OLD_DIRS=()
declare -a CAND_LABEL CAND_KIND CAND_ID CAND_DIR
add_cand() { CAND_LABEL+=("$1"); CAND_KIND+=("$2"); CAND_ID+=("$3"); CAND_DIR+=("$4"); }

if pm2 jlist >/dev/null 2>&1; then
  while IFS=$'\t' read -r name status cwd; do
    [ -z "$name" ] && continue
    [ "$name" = "$APP_NAME" ] && continue
    add_cand "pm2: $name ($status) di $cwd" pm2 "$name" "$cwd"
  done < <(pm2 jlist 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{for(const p of JSON.parse(s))console.log([p.name,p.pm2_env.status,p.pm2_env.pm_cwd].join("\t"))}catch{}})')
fi

APP_REAL="$(readlink -f "$APP_DIR")"
while read -r pid args; do
  [ -z "${pid:-}" ] && continue
  case "$args" in *"PM2 v"*|*"pm2 "*|*"/pm2/"*) continue ;; esac
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [ "$cwd" = "$APP_REAL" ] && continue
  unit="$(grep -o '[^/]*\.service' "/proc/$pid/cgroup" 2>/dev/null | head -n1 || true)"
  if [ -n "$unit" ] && [ "$unit" != "pm2-root.service" ] && [[ "$unit" != pm2-* ]] && [[ "$unit" != user@* ]] && [[ "$unit" != session-* ]]; then
    add_cand "systemd: $unit (PID $pid) — $args" systemd "$unit" "$cwd"
  else
    # proses pm2 sudah tercatat di atas
    if pm2 jlist 2>/dev/null | grep -q "\"pid\":$pid,"; then continue; fi
    add_cand "proses: PID $pid — $args (folder $cwd)" pid "$pid" "$cwd"
  fi
done < <(ps -eo pid=,args= | awk '$2 ~ /(^|\/)(node|nodejs|bun|python3?)$/ && $3 !~ /^\/usr\// {print}' || true)

if [ "${#CAND_LABEL[@]}" -eq 0 ]; then
  info "Tidak ada bot lama yang terdeteksi."
else
  info "Ditemukan proses berikut:"
  for i in "${!CAND_LABEL[@]}"; do info "  [$((i+1))] ${CAND_LABEL[$i]}"; done
  warn "Bot lama HARUS dimatikan, kalau tidak dua bot akan membalas di nomor yang sama."
  PICK="$(ask "Nomor bot lama yang mau dimatikan (pisahkan spasi, Enter = lewati):")"
  for n in $PICK; do
    i=$((n-1))
    [ "$i" -ge 0 ] && [ "$i" -lt "${#CAND_LABEL[@]}" ] || { warn "Nomor $n tidak ada, dilewati"; continue; }
    case "${CAND_KIND[$i]}" in
      pm2) pm2 stop "${CAND_ID[$i]}" >/dev/null && pm2 delete "${CAND_ID[$i]}" >/dev/null ;;
      systemd) $SUDO systemctl stop "${CAND_ID[$i]}" && $SUDO systemctl disable "${CAND_ID[$i]}" >/dev/null 2>&1 || true ;;
      pid) $SUDO kill "${CAND_ID[$i]}" || true ;;
    esac
    info "Dimatikan: ${CAND_LABEL[$i]}"
    OLD_DIRS+=("${CAND_DIR[$i]}")
  done
  pm2 save --force >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- 4. konfigurasi
say "4/7 Menyiapkan konfigurasi (.env)"
ENV_FILE="$APP_DIR/.env"
find_in_old_env() { # $1 = regex nama variabel
  for d in "${OLD_DIRS[@]}"; do
    for f in "$d/.env" "$d/../.env"; do
      [ -f "$f" ] || continue
      v="$(grep -E "^\s*($1)\s*=" "$f" | grep -viE '^\s*[A-Z_]*BOT' | head -n1 | sed -E 's/^[^=]*=\s*//; s/^["'\'']//; s/["'\'']\s*$//' || true)"
      [ -n "$v" ] && { printf '%s' "$v"; return 0; }
    done
  done
  return 0
}
if [ -f "$ENV_FILE" ]; then
  info ".env sudah ada, dipakai apa adanya."
else
  API_KEY="$(find_in_old_env 'ANTHROPIC_API_KEY|CLAUDE_API_KEY')"
  if [ -n "$API_KEY" ]; then
    info "API key Claude diambil dari konfigurasi bot lama (…${API_KEY: -4})."
  else
    API_KEY="$(ask_secret "Tempel API key Claude (sk-ant-…, tidak akan tampil di layar):")"
  fi
  [ -n "$API_KEY" ] || die "API key wajib diisi."

  OLD_OWNER="$(find_in_old_env '[A-Z_]*(OWNER|ADMIN|NOMOR|PHONE|NUMBER)[A-Z_]*' | tr -cd '0-9')"
  if [ -n "$OLD_OWNER" ]; then
    ANS="$(ask "Nomor WhatsApp kamu (yang dilayani bot) = $OLD_OWNER ? Enter kalau benar, atau ketik nomor lain:")"
    OWNER="${ANS:-$OLD_OWNER}"
  else
    OWNER="$(ask "Nomor WhatsApp kamu yang dilayani bot (contoh 6281234567890):")"
  fi
  OWNER="$(printf '%s' "$OWNER" | tr -cd '0-9')"
  case "$OWNER" in 0*) OWNER="62${OWNER#0}" ;; esac
  [ -n "$OWNER" ] || die "Nomor wajib diisi."

  umask 077
  cat >"$ENV_FILE" <<EOF
ANTHROPIC_API_KEY=$API_KEY
OWNER_NUMBER=$OWNER
TIMEZONE=Asia/Jakarta
EOF
  info ".env dibuat (pemilik: $OWNER)."
fi

# ---------------------------------------------------------------- 5. dependensi
say "5/7 Memasang dependensi dan menjalankan tes"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund --loglevel=error
npm test >/tmp/wa-todo-bot-test.log 2>&1 && info "Tes lulus." || { warn "Ada tes yang gagal, lihat /tmp/wa-todo-bot-test.log"; }
node --env-file=.env src/check.js || die "Perbaiki API key di $ENV_FILE lalu jalankan skrip ini lagi."

# ---------------------------------------------------------------- 6. login WhatsApp
say "6/7 Login WhatsApp nomor bot"
AUTH_DIR="$APP_DIR/data/wa-auth"
if [ ! -f "$AUTH_DIR/creds.json" ]; then
  for d in "${OLD_DIRS[@]}"; do
    found="$(find "$d" -maxdepth 4 -name creds.json -not -path '*/node_modules/*' 2>/dev/null | head -n1 || true)"
    if [ -n "$found" ]; then
      mkdir -p "$AUTH_DIR"
      cp -a "$(dirname "$found")/." "$AUTH_DIR/"
      info "Sesi WhatsApp bot lama ditemukan dan dipakai ulang ($(dirname "$found"))."
      break
    fi
  done
fi
login() { node --env-file=.env src/index.js --login; }
if [ -f "$AUTH_DIR/creds.json" ]; then
  info "Mengecek sesi WhatsApp…"
  set +e; timeout 90 node --env-file=.env src/index.js --login >/tmp/wa-todo-bot-login.log 2>&1; rc=$?; set -e
  if [ "$rc" -eq 0 ]; then
    info "Sesi WhatsApp aktif, tidak perlu scan QR."
  else
    warn "Sesi lama tidak bisa dipakai. Perlu scan QR baru."
    rm -rf "$AUTH_DIR"
  fi
fi
if [ ! -f "$AUTH_DIR/creds.json" ]; then
  info "QR akan muncul. Di HP nomor bot: WhatsApp → Perangkat tertaut → Tautkan perangkat → scan."
  info "(Kalau sebelumnya bot lama tertaut, hapus dulu perangkat lamanya dari daftar itu.)"
  login || die "Login WhatsApp gagal. Jalankan skrip ini lagi untuk mencoba ulang."
fi

# ---------------------------------------------------------------- 7. jalankan
say "7/7 Menjalankan bot di background"
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start src/index.js --name "$APP_NAME" --cwd "$APP_DIR" --node-args="--env-file=$APP_DIR/.env" >/dev/null
pm2 save --force >/dev/null
if [ "$(id -u)" -eq 0 ]; then
  pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
else
  $SUDO env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$(id -un)" --hp "$HOME" >/dev/null 2>&1 || true
fi
sleep 8
pm2 logs "$APP_NAME" --lines 15 --nostream || true

say "Selesai! 🎉"
info "Coba chat bot dari nomor $(grep OWNER_NUMBER "$ENV_FILE" | cut -d= -f2)."
info "Lihat log:        pm2 logs $APP_NAME"
info "Restart:          pm2 restart $APP_NAME"
info "Update nanti:     jalankan perintah pemasangan yang sama lagi."
