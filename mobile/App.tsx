import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { Relay } from "./src/relay/types";
import type { Session } from "./src/server/types";
import { Browser } from "./src/ui/Browser";
import { FirstRun } from "./src/ui/FirstRun";

export default function App() {
	const [ready, setReady] = useState<{ session: Session; relay: Relay } | null>(null);
	return (
		<SafeAreaProvider>
			{ready ? <Browser {...ready} onSignOut={() => setReady(null)} /> : <FirstRun onReady={setReady} />}
			<StatusBar style="dark" />
		</SafeAreaProvider>
	);
}
