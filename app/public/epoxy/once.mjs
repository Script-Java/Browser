// The epoxy transport, started once. bare-mux starts a transport on its first
// request (`ready || await init()`), so two first requests at the same moment
// started it twice, and the second start swapped out the WebAssembly the
// first one's connection was running in: the worker hung, and with it the
// origin's whole proxy connection. Two frames of one site in a page are
// enough for that (with site isolation each framed site has an origin, and
// so a transport, of its own).
import EpoxyTransport from "./index.mjs";

export default class extends EpoxyTransport {
	init() {
		// a start that failed is tried again by the next request
		return (this.starting ||= super.init().finally(() => (this.starting = null)));
	}
}
