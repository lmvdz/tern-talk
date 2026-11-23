// Run before mail.ts reads its spool paths. Tern starts the relay in a new shell.
for (const arg of process.argv.slice(2)) {
	const assignment = /^(TERN_LINK_HOME|OMP_TERN_TALK_HOME|TERN_DAEMON_SOCKET)=(.*)$/s.exec(arg);
	if (!assignment) throw new Error("Invalid Tern talk relay argument.");
	process.env[assignment[1]] = assignment[2];
}
