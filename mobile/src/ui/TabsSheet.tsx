// The tab switcher: this workspace's tabs, the workspaces, new and close.
import { ActionSheetIOS, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { hostOf } from "../address";
import { colors, IconButton, Note, Row, Sheet, styles as kit } from "./kit";
import type { TabInfo } from "./Tab";

export type Workspace = { id: string; name: string };

type Props = {
	tabs: TabInfo[];
	active: string | null;
	workspaces: Workspace[];
	workspace: string;
	onSelect: (id: string) => void;
	onCloseTab: (id: string) => void;
	onNewTab: (isPrivate: boolean) => void;
	onWorkspace: (id: string) => void;
	onAddWorkspace: (name: string) => void;
	onRenameWorkspace: (id: string, name: string) => void;
	onRemoveWorkspace: (id: string) => void;
	onClose: () => void;
};

export function TabsSheet(props: Props) {
	const { tabs, active, workspaces, workspace, onSelect, onCloseTab, onNewTab, onWorkspace, onClose } = props;
	const shown = tabs.filter((t) => t.workspace === workspace);

	const addWorkspace = () =>
		Alert.prompt("New workspace", "Its tabs keep their own sign-ins and site data.", (name) => name?.trim() && props.onAddWorkspace(name.trim()));

	const manage = (w: Workspace, index: number) =>
		ActionSheetIOS.showActionSheetWithOptions(
			// the first workspace is the default one and stays
			{ title: w.name, options: index === 0 ? ["Rename", "Cancel"] : ["Rename", "Remove", "Cancel"], cancelButtonIndex: index === 0 ? 1 : 2, destructiveButtonIndex: index === 0 ? undefined : 1 },
			(choice) => {
				if (choice === 0) Alert.prompt("Rename workspace", undefined, (name) => name?.trim() && props.onRenameWorkspace(w.id, name.trim()), "plain-text", w.name);
				if (choice === 1 && index !== 0)
					Alert.alert(`Remove ${w.name}?`, "Its tabs close, and its sign-ins and site data are deleted.", [
						{ text: "Cancel", style: "cancel" },
						{ text: "Remove", style: "destructive", onPress: () => props.onRemoveWorkspace(w.id) },
					]);
			}
		);

	return (
		<Sheet title="Tabs" visible onClose={onClose}>
			<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
				{workspaces.map((w, i) => (
					<Pressable
						key={w.id}
						accessibilityRole="button"
						accessibilityState={{ selected: w.id === workspace }}
						accessibilityHint="Touch and hold to rename or remove"
						onPress={() => onWorkspace(w.id)}
						onLongPress={() => manage(w, i)}
						style={[styles.chip, w.id === workspace && styles.chipOn]}
					>
						<Text style={[styles.chipText, w.id === workspace && styles.chipTextOn]}>{w.name}</Text>
					</Pressable>
				))}
				<IconButton icon="plus" label="New workspace" onPress={addWorkspace} />
			</ScrollView>

			{shown.length ? null : <Note>No tabs in this workspace.</Note>}
			{shown.map((t) => (
				<View key={t.id} style={[kit.row, t.id === active && styles.activeRow]}>
					<Pressable accessibilityRole="button" accessibilityState={{ selected: t.id === active }} style={kit.rowText} onPress={() => onSelect(t.id)}>
						<Text style={kit.label} numberOfLines={1}>
							{t.private ? "Private: " : ""}
							{t.title || (t.url ? hostOf(t.url) : "New tab")}
						</Text>
						{t.url ? (
							<Text style={kit.note} numberOfLines={1}>
								{hostOf(t.url)}
							</Text>
						) : null}
					</Pressable>
					<IconButton icon="xmark" label={`Close ${t.title || "tab"}`} onPress={() => onCloseTab(t.id)} />
				</View>
			))}

			<View style={styles.actions}>
				<Row label="New tab" onPress={() => onNewTab(false)} />
				<Row label="New private tab" note="Nothing from it is kept: its site data goes when the app closes." onPress={() => onNewTab(true)} />
			</View>
		</Sheet>
	);
}

const styles = StyleSheet.create({
	chips: { gap: 8, alignItems: "center", paddingBottom: 16 },
	chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: colors.field },
	chipOn: { backgroundColor: colors.ink },
	chipText: { fontSize: 15, color: colors.text },
	chipTextOn: { color: "#fff" },
	activeRow: { backgroundColor: colors.chrome },
	actions: { marginTop: 20 },
});
