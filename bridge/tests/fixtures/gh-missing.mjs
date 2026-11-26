// 模拟「这台机器没装 gh」：真 gh 不在时 execFile 会 ENOENT，这里用 127 + 那句典型输出。
process.stderr.write("bash: gh: command not found\n");
process.exit(127);
