// The few building blocks the screens share, in the old app's colours (app/public/index.css).
import { type SFSymbol, SymbolView } from "expo-symbols";
import { type ReactNode, useCallback, useEffect, useReducer, useRef } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

export const colors = {
	bg: "#faf9f7",
	chrome: "#ecebe8",
	toolbar: "#f7f6f4",
	field: "#e9e8e4",
	surface: "#ffffff",
	line: "#e2e0dc",
	ink: "#1f1e1d",
	text: "#2b2a28",
	muted: "#6f6c68",
	danger: "#c43d3d",
	warning: "#7f1d1d",
};

/** `later(fn)` runs fn after the next commit: once this render's props have reached the native views. */
export function useAfterRender() {
	const queue = useRef<(() => void)[]>([]);
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		for (const fn of queue.current.splice(0)) fn();
	});
	return useCallback((fn: () => void) => {
		queue.current.push(fn);
		rerender();
	}, []);
}

export function IconButton({ icon, label, onPress, disabled }: { icon: SFSymbol; label: string; onPress: () => void; disabled?: boolean }) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={{ disabled }}
			disabled={disabled}
			onPress={onPress}
			hitSlop={6}
			style={({ pressed }) => [styles.icon, pressed && styles.pressed, disabled && styles.disabled]}
		>
			<SymbolView name={icon} size={20} tintColor={colors.ink} />
		</Pressable>
	);
}

/** A sheet over the browser, with a title and Done. */
export function Sheet({ title, visible, onClose, children }: { title: string; visible: boolean; onClose: () => void; children: ReactNode }) {
	return (
		<Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
			<View style={styles.sheet}>
				<View style={styles.header}>
					<Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
						{title}
					</Text>
					<Pressable accessibilityRole="button" onPress={onClose} hitSlop={8}>
						<Text style={styles.done}>Done</Text>
					</Pressable>
				</View>
				<ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
					{children}
				</ScrollView>
			</View>
		</Modal>
	);
}

export function Heading({ children }: { children: ReactNode }) {
	return <Text style={styles.heading}>{children}</Text>;
}

export function Note({ children }: { children: ReactNode }) {
	return <Text style={styles.note}>{children}</Text>;
}

/** A row: a label, an optional note, and a control or a tick. */
export function Row({ label, note, onPress, checked, right, danger }: { label: string; note?: string; onPress?: () => void; checked?: boolean; right?: ReactNode; danger?: boolean }) {
	return (
		<Pressable
			accessibilityRole={checked === undefined ? (onPress ? "button" : undefined) : "radio"}
			accessibilityState={checked === undefined ? undefined : { checked }}
			disabled={!onPress}
			onPress={onPress}
			style={({ pressed }) => [styles.row, pressed && styles.pressed]}
		>
			<View style={styles.rowText}>
				<Text style={[styles.label, danger && { color: colors.danger }]}>{label}</Text>
				{note ? <Text style={styles.note}>{note}</Text> : null}
			</View>
			{checked ? <SymbolView name="checkmark" size={16} tintColor={colors.ink} /> : right}
		</Pressable>
	);
}

export const styles = StyleSheet.create({
	icon: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 10 },
	pressed: { opacity: 0.5 },
	disabled: { opacity: 0.3 },
	sheet: { flex: 1, backgroundColor: colors.bg },
	header: { flexDirection: "row", alignItems: "center", padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
	title: { flex: 1, fontSize: 17, fontWeight: "600", color: colors.ink },
	done: { fontSize: 17, fontWeight: "600", color: colors.ink },
	body: { padding: 16, paddingBottom: 48 },
	heading: { marginTop: 20, marginBottom: 6, fontSize: 13, fontWeight: "600", color: colors.muted, textTransform: "uppercase" },
	row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
	rowText: { flex: 1 },
	label: { fontSize: 16, color: colors.text },
	note: { marginTop: 2, fontSize: 13, color: colors.muted },
	mono: { fontFamily: "Menlo", fontSize: 12, color: colors.text },
});
