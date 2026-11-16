// Bookmarks and history, as the old app's library.
import { Alert, Pressable, StyleSheet, Text } from "react-native";

import { hostOf } from "../address";
import { type Entry, nameOf, type Page, timeAgo } from "../library";
import { colors, Heading, Note, Row, Sheet } from "./kit";

type Props = {
	bookmarks: Page[];
	history: Entry[];
	onOpen: (url: string) => void;
	onRemoveBookmark: (url: string) => void;
	onClearHistory: () => void;
	onClose: () => void;
};

export function LibrarySheet({ bookmarks, history, onOpen, onRemoveBookmark, onClearHistory, onClose }: Props) {
	const clear = () =>
		Alert.alert("Clear history?", "Every page in it is forgotten. Bookmarks, open tabs and sites' sign-ins stay.", [
			{ text: "Cancel", style: "cancel" },
			{ text: "Clear", style: "destructive", onPress: onClearHistory },
		]);

	return (
		<Sheet title="Bookmarks and history" visible onClose={onClose}>
			<Heading>Bookmarks</Heading>
			{bookmarks.length ? null : <Note>None yet: “Bookmark this page” in the ⋯ menu adds one.</Note>}
			{bookmarks.map((b) => (
				<Row
					key={b.url}
					label={nameOf(b)}
					note={hostOf(b.url)}
					onPress={() => onOpen(b.url)}
					right={
						<Pressable accessibilityRole="button" accessibilityLabel={`Remove bookmark ${nameOf(b)}`} hitSlop={8} onPress={() => onRemoveBookmark(b.url)}>
							<Text style={styles.remove}>Remove</Text>
						</Pressable>
					}
				/>
			))}

			<Heading>History</Heading>
			{history.length ? null : <Note>Pages you open show up here. Private tabs add nothing.</Note>}
			{/* shortcut: the latest 300, as the old app; search or paging when people want older ones */}
			{history.slice(0, 300).map((h) => (
				<Row key={`${h.at}${h.url}`} label={nameOf(h)} note={`${hostOf(h.url)} · ${timeAgo(h.at)}`} onPress={() => onOpen(h.url)} />
			))}
			{history.length ? <Row label="Clear history" danger onPress={clear} /> : null}
		</Sheet>
	);
}

const styles = StyleSheet.create({
	remove: { fontSize: 15, color: colors.danger },
});
