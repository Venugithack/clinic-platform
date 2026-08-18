#!/usr/bin/env bash
# HTTPS on the clinic LAN. BUILD.md §1.3 — day 1, not later.
#
# This is the trap in HOSTING.md §1a. The camera, service workers and PWA
# install all need a secure context, and http://192.168.x.x is not one. So
# without this, on the tablets:
#
#   - the app will not install as a PWA, it stays a browser tab;
#   - the service worker will not register, so there is no offline write queue;
#   - the camera will not open, so barcode scanning silently does nothing.
#
# All three fail quietly and none of them fails on the dev machine. Done on
# day 1 this costs an hour. Discovered in M3 it costs a day and looks like a
# defect in the barcode feature.
#
# THIS SCRIPT RUNS IN THE CLINIC, on the dev machine, on the clinic Wi-Fi. It
# cannot be run from anywhere else — steps 1 and 3 involve the clinic's router
# and physically holding both tablets.
set -euo pipefail

HOST="${CLINIC_LAN_HOST:-clinic.local}"
CERT_DIR="${CERT_DIR:-./certs}"

cat <<BANNER
─────────────────────────────────────────────────────────────
 HTTPS on the clinic LAN — ${HOST}
─────────────────────────────────────────────────────────────

 Before running this, on the clinic router:

   1. Give the dev machine a STATIC DHCP RESERVATION.
      A certificate is issued to a name, and the name has to keep
      pointing at the same machine after a reboot.

 After running this, on BOTH tablets (five minutes each, once):

   3. Install the mkcert root CA:
        - copy ${CERT_DIR}/rootCA.pem to the tablet
        - Android: Settings → Security → Encryption & credentials
                   → Install a certificate → CA certificate
        - confirm https://${HOST}:3000 shows no warning
        - then install the PWA from the browser menu

   4. The printer — an HP Smart Tank 580. Two things, not one:

      a) Put the printer and BOTH tablets on the same 2.4 GHz network,
         and switch AP isolation / guest-network isolation off.
           - this printer is 802.11b/g/n, 2.4 GHz only. A dual-band
             router with one SSID can leave the tablets on 5 GHz, and
             where the bands are isolated mDNS discovery does not cross
             between them.
           - do NOT confirm this with a ping. A ping passes on a network
             where discovery still fails. Confirm it in step (c).

      b) Install HP Print Service Plugin on both tablets (Mopria Print
         Service also works — this printer is Mopria-certified — but
         HP's own is the safer pick for an HP printer).
           - Android does NOT discover network printers on its own.
             With no plugin the print dialog finds nothing, and the
             printer looks broken when it is not.

      c) Open the print dialog on each tablet and confirm the printer
         appears BY NAME. Then print one real prescription and keep
         the sheet.

 Both tablets need all of this. A certificate the tablet does not trust
 fails exactly like no certificate at all; a print dialog with no plugin
 behind it fails exactly like a printer that is switched off; and a
 tablet on the wrong Wi-Fi band fails exactly like both.

 Note there is no wired fallback: this printer has Wi-Fi and USB, no
 Ethernet. If the clinic Wi-Fi is down, nothing prints.

─────────────────────────────────────────────────────────────
BANNER

if ! command -v mkcert >/dev/null 2>&1; then
  cat >&2 <<'MISSING'
mkcert is not installed.

  macOS          brew install mkcert nss
  Debian/Ubuntu  apt install mkcert   (or download the release binary)
  Windows        choco install mkcert
MISSING
  exit 1
fi

mkdir -p "${CERT_DIR}"

# Step 2: the local CA and the certificate for the LAN hostname.
mkcert -install
mkcert -cert-file "${CERT_DIR}/${HOST}.pem" \
       -key-file  "${CERT_DIR}/${HOST}-key.pem" \
       "${HOST}" "*.${HOST}" localhost 127.0.0.1

cp "$(mkcert -CAROOT)/rootCA.pem" "${CERT_DIR}/rootCA.pem"

cat <<DONE

Certificate written to ${CERT_DIR}/${HOST}.pem
Root CA to copy to both tablets: ${CERT_DIR}/rootCA.pem

Serve the app over it with:

  next dev --experimental-https \\
    --experimental-https-key  ${CERT_DIR}/${HOST}-key.pem \\
    --experimental-https-cert ${CERT_DIR}/${HOST}.pem

Then, on each tablet, confirm all four before calling M0 §1.3 done:

  [ ] https://${HOST}:3000 loads with no certificate warning
  [ ] the app installs to the home screen and opens fullscreen
  [ ] the camera opens when a scan button is tapped
  [ ] the clinic's A4 appears in the print dialog, and a real
      prescription prints on it

DONE
