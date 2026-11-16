// Downloads this launch; a finished one opens the share sheet (Save to Files, AirDrop, apps).
import * as Sharing from "expo-sharing";
import { Alert } from "react-native";

import type { Download } from "../../modules/badger-webview";
import { Note, Row, Sheet } from "./kit";

// shortcut: the list is this launch's only; keep it in a file if people want it back after a restart
export function DownloadsSheet({ downloads, onClose }: { downloads: Download[]; onClose: () => void }) {
	const share = (path: string) => Sharing.shareAsync(path).catch((err) => Alert.alert("Couldn't share this file", String(err?.message ?? err)));

	return (
		<Sheet title="Downloads" visible onClose={onClose}>
			{downloads.length ? null : <Note>Nothing downloaded yet.</Note>}
			{downloads.map((d) => (
				<Row
					key={d.id}
					label={d.filename}
					note={d.state === "started" ? "Downloading…" : d.state === "failed" ? `Failed${d.error ? `: ${d.error}` : ""}` : "Share or save"}
					onPress={d.state === "finished" && d.path ? () => share(d.path!) : undefined}
				/>
			))}
		</Sheet>
	);
}
