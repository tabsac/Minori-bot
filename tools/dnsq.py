#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""极简 DNS 查询（UDP，支持压缩指针），用来查 A / NS / CNAME。

用法：
    dnsq.py <域名> [A|NS|CNAME|TXT|MX] [服务器IP，默认 223.5.5.5]
    dnsq.py on.tabsac.com A anita.ns.cloudflare.com
"""
import random
import socket
import struct
import sys

TYPES = {"A": 1, "NS": 2, "CNAME": 5, "MX": 15, "TXT": 16, "AAAA": 28}


def build(name, qtype):
    tid = random.randint(0, 65535)
    header = struct.pack(">HHHHHH", tid, 0x0100, 1, 0, 0, 0)
    q = b"".join(bytes([len(p)]) + p.encode("utf-8") for p in name.rstrip(".").split(".")) + b"\x00"
    return header + q + struct.pack(">HH", qtype, 1), tid


def read_name(data, off):
    labels = []
    jumped = False
    end = off
    while True:
        if off >= len(data):
            break
        length = data[off]
        if length == 0:
            off += 1
            if not jumped:
                end = off
            break
        if length & 0xC0 == 0xC0:
            ptr = struct.unpack(">H", data[off:off + 2])[0] & 0x3FFF
            if not jumped:
                end = off + 2
            off, jumped = ptr, True
            continue
        labels.append(data[off + 1:off + 1 + length].decode("utf-8", "ignore"))
        off += 1 + length
    return ".".join(labels), end


def query(name, qtype, server):
    pkt, tid = build(name, qtype)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(6)
    s.sendto(pkt, (server, 53))
    data, _ = s.recvfrom(4096)
    _, _, qd, an, ns, ar = struct.unpack(">HHHHHH", data[:12])
    rcode = data[3] & 0x0F
    off = 12
    for _ in range(qd):
        _, off = read_name(data, off)
        off += 4
    out = []
    for _ in range(an):
        nm, off = read_name(data, off)
        rtype, _cls, ttl, rdlen = struct.unpack(">HHIH", data[off:off + 10])
        off += 10
        rdata = data[off:off + rdlen]
        if rtype == 1:
            out.append(("A", nm, socket.inet_ntoa(rdata), ttl))
        elif rtype == 28:
            out.append(("AAAA", nm, ":".join("%02x" % b for b in rdata), ttl))
        elif rtype in (2, 5):
            val, _ = read_name(data, off)
            out.append(("NS" if rtype == 2 else "CNAME", nm, val, ttl))
        elif rtype == 16:
            txt = "".join(rdata[i + 1:i + 1 + rdata[i]].decode("utf-8", "ignore")
                          for i in range(0, len(rdata), 1) if i < len(rdata))
            out.append(("TXT", nm, txt[:200], ttl))
        else:
            out.append(("TYPE%d" % rtype, nm, rdata.hex()[:80], ttl))
        off += rdlen
    return rcode, out


if __name__ == "__main__":
    name = sys.argv[1]
    qtype = TYPES.get((sys.argv[2] if len(sys.argv) > 2 else "A").upper(), 1)
    server = sys.argv[3] if len(sys.argv) > 3 else "223.5.5.5"
    try:
        server_ip = socket.gethostbyname(server)
    except OSError:
        server_ip = server
    rcode, rows = query(name, qtype, server_ip)
    tag = {0: "OK", 3: "NXDOMAIN"}.get(rcode, "RCODE%d" % rcode)
    print("  %-22s %-4s @%-22s %s" % (name, sys.argv[2].upper() if len(sys.argv) > 2 else "A", server, tag))
    for t, nm, val, ttl in rows:
        print("      %-5s %-24s %s  (ttl %d)" % (t, nm, val, ttl))
    if not rows and rcode == 0:
        print("      （没有记录）")
