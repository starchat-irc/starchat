/**
 * GIFs module (feature "gifs")
 * GIF search in the message input. The server proxies a GIF service and names it in
 * `provider` for the attribution line. API: docs/discovery.md.
 */

const PAGE_SIZE = 20;

function emptyGifPicker() {
    return { search: '', results: [], loading: false, nextPage: null, provider: null, failed: false };
}

/** Results with an id and two https URLs, provider only with an https link. */
export function normalizeGifResults(data) {
    const isHttps = value => typeof value === 'string' && value.startsWith('https://');
    const results = (Array.isArray(data?.results) ? data.results : [])
        .filter(gif => gif && gif.id !== undefined && gif.id !== '' && isHttps(gif.url) && isHttps(gif.preview))
        .map(gif => ({ id: String(gif.id), title: String(gif.title || ''), url: gif.url, preview: gif.preview }));
    const next = data?.next ?? null;
    const provider = typeof data?.provider?.name === 'string' && isHttps(data.provider.url)
        ? { name: data.provider.name, url: data.provider.url }
        : null;
    return { results, next: next === null || next === '' ? null : String(next), provider };
}

export function gifsMixin() {
    return {
        gifPicker: emptyGifPicker(),
        _gifRequest: 0,

        openGifPickerResults() {
            this.gifPicker = { ...emptyGifPicker(), provider: this.gifPicker.provider };
            return this.searchGifs();
        },

        async searchGifs(append = false) {
            if (!this.hasFeature('gifs')) return;
            const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
            const query = this.gifPicker.search.trim();
            if (query) params.set('q', query);
            if (append) {
                if (!this.gifPicker.nextPage) return;
                params.set('page', this.gifPicker.nextPage);
            }

            // Typing fires several searches, only the newest may fill the list
            const request = ++this._gifRequest;
            this.gifPicker.loading = true;
            this.gifPicker.failed = false;
            try {
                const response = await this.connection.api(`gifs/search?${params}`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = normalizeGifResults(await response.json());
                if (request !== this._gifRequest) return;
                this.gifPicker.results = append ? [...this.gifPicker.results, ...data.results] : data.results;
                this.gifPicker.nextPage = data.next;
                if (data.provider) this.gifPicker.provider = data.provider;
            } catch (error) {
                if (request !== this._gifRequest) return;
                if (!append) this.gifPicker.results = [];
                this.gifPicker.failed = true;
                console.warn('GIF search failed:', error);
            } finally {
                if (request === this._gifRequest) this.gifPicker.loading = false;
            }
        },

        loadMoreGifs() {
            if (this.gifPicker.nextPage && !this.gifPicker.loading) this.searchGifs(true);
        },

        sendGif(gif) {
            if (!gif?.url) return;
            this.showGifPicker = false;
            this.newMessage = gif.url;
            this.sendMessage();
        },
    };
}

/** @type {import('./index.js').ChatModule} */
export const gifsModule = {
    name: 'gifs',
    mixin: gifsMixin,
};
