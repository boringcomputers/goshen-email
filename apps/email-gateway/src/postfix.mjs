export function postfixConfiguration(hostname, tlsChain) {
  return {
    main: `compatibility_level = 3.6
myhostname = ${hostname}
myorigin = $myhostname
enable_long_queue_ids = yes
mydestination =
inet_interfaces = all
inet_protocols = ipv4
mynetworks = 127.0.0.0/8
parent_domain_matches_subdomains =
relay_domains = socketmap:inet:127.0.0.1:10031:domains
relay_recipient_maps = socketmap:inet:127.0.0.1:10031:recipients
relay_transport = bezalel
default_transport = smtp
smtp_host_lookup = dns
smtp_dns_reply_filter = regexp:/etc/postfix/smtp_dns_reply_filter
smtpd_relay_restrictions = reject_unauth_destination
smtpd_recipient_restrictions = reject_unlisted_recipient
smtpd_reject_unlisted_recipient = yes
disable_vrfy_command = yes
smtpd_helo_required = yes
message_size_limit = 25000000
mailbox_size_limit = 0
recipient_delimiter =
bezalel_destination_recipient_limit = 1
bezalel_destination_concurrency_limit = 10
bezalel_time_limit = 150s
minimal_backoff_time = 30s
queue_run_delay = 30s
maximal_queue_lifetime = 5d
bounce_queue_lifetime = 5d
smtp_tls_security_level = may
smtpd_tls_security_level = may
smtpd_tls_chain_files = ${tlsChain}
smtpd_tls_protocols = >=TLSv1.2
smtp_tls_protocols = >=TLSv1.2
maillog_file = /var/spool/postfix/bezalel/postfix.log
maillog_file_prefixes = /var/spool/postfix/bezalel
maillog_file_compressor = /bin/true
`,
    master: `smtp inet n - n - 10 smtpd
127.0.0.1:10025 inet n - n - 10 smtpd
  -o smtpd_relay_restrictions=permit_mynetworks,reject
  -o smtpd_recipient_restrictions=permit_mynetworks,reject
  -o smtpd_reject_unlisted_recipient=no
  -o smtpd_tls_security_level=none
pickup unix n - n 60 1 pickup
cleanup unix n - n - 0 cleanup
qmgr unix n - n 300 1 qmgr
tlsmgr unix - - n 1000? 1 tlsmgr
rewrite unix - - n - - trivial-rewrite
bounce unix - - n - 0 bounce
defer unix - - n - 0 bounce
trace unix - - n - 0 bounce
verify unix - - n - 1 verify
flush unix n - n 1000? 0 flush
proxymap unix - - n - - proxymap
proxywrite unix - - n - 1 proxymap
smtp unix - - n - - smtp
relay unix - - n - - smtp
showq unix n - n - - showq
error unix - - n - - error
retry unix - - n - - error
discard unix - - n - - discard
anvil unix - - n - 1 anvil
scache unix - - n - 1 scache
postlog unix-dgram n - n - 1 postlogd
bezalel unix - n n - 10 pipe
  flags=R null_sender=<> user=nobody argv=/usr/local/bin/node --use-system-ca /app/src/deliver.mjs \${recipient} \${sender} \${client_address} \${client_helo}
`,
  }
}

// Customer MX records must not turn email sending into access to private hosts.
export const smtpDnsFilter = String.raw`/[[:space:]]IN[[:space:]]+A[[:space:]]+(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|192\.0\.(0|2)\.|198\.(18|19)\.|198\.51\.100\.|203\.0\.113\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|22[4-9]\.|2[3-5][0-9]\.)/ IGNORE
/[[:space:]]IN[[:space:]]+MX[[:space:]]+[0-9]+[[:space:]]+[0-9.]+$/ IGNORE
`
