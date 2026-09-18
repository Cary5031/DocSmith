export namespace main {
	
	export class AIPolicy {
	    disabled: boolean;
	    allowedProviders: string[];
	    lockedBaseUrl: string;
	
	    static createFrom(source: any = {}) {
	        return new AIPolicy(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.disabled = source["disabled"];
	        this.allowedProviders = source["allowedProviders"];
	        this.lockedBaseUrl = source["lockedBaseUrl"];
	    }
	}
	export class AIHeader {
	    name: string;
	    value: string;
	
	    static createFrom(source: any = {}) {
	        return new AIHeader(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.value = source["value"];
	    }
	}
	export class AIProviderView {
	    baseUrl: string;
	    model: string;
	    keyHint: string;
	    headers: AIHeader[];
	
	    static createFrom(source: any = {}) {
	        return new AIProviderView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.baseUrl = source["baseUrl"];
	        this.model = source["model"];
	        this.keyHint = source["keyHint"];
	        this.headers = this.convertValues(source["headers"], AIHeader);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AIConfigView {
	    active: string;
	    accepted: boolean;
	    providers: Record<string, AIProviderView>;
	    policy: AIPolicy;
	    defaults: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new AIConfigView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.active = source["active"];
	        this.accepted = source["accepted"];
	        this.providers = this.convertValues(source["providers"], AIProviderView, true);
	        this.policy = this.convertValues(source["policy"], AIPolicy);
	        this.defaults = source["defaults"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	export class AISaveRequest {
	    active: string;
	    provider: string;
	    baseUrl: string;
	    model: string;
	    key: string;
	    headers: AIHeader[];
	    accepted: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AISaveRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.active = source["active"];
	        this.provider = source["provider"];
	        this.baseUrl = source["baseUrl"];
	        this.model = source["model"];
	        this.key = source["key"];
	        this.headers = this.convertValues(source["headers"], AIHeader);
	        this.accepted = source["accepted"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AITestResult {
	    ok: boolean;
	    latency: number;
	    models: number;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new AITestResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.latency = source["latency"];
	        this.models = source["models"];
	        this.message = source["message"];
	    }
	}
	export class DirEntry {
	    name: string;
	    path: string;
	    isDir: boolean;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new DirEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.isDir = source["isDir"];
	        this.size = source["size"];
	    }
	}
	export class Document {
	    path: string;
	    content: string;
	    encoding: string;
	    crlf: boolean;
	    bom: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Document(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	        this.encoding = source["encoding"];
	        this.crlf = source["crlf"];
	        this.bom = source["bom"];
	    }
	}
	export class ImportTarget {
	    markdownPath: string;
	    assetsDir: string;
	
	    static createFrom(source: any = {}) {
	        return new ImportTarget(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.markdownPath = source["markdownPath"];
	        this.assetsDir = source["assetsDir"];
	    }
	}
	export class SearchMatch {
	    line: number;
	    column: number;
	    length: number;
	    text: string;
	
	    static createFrom(source: any = {}) {
	        return new SearchMatch(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.line = source["line"];
	        this.column = source["column"];
	        this.length = source["length"];
	        this.text = source["text"];
	    }
	}
	export class SearchFileResult {
	    path: string;
	    matches: SearchMatch[];
	
	    static createFrom(source: any = {}) {
	        return new SearchFileResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.matches = this.convertValues(source["matches"], SearchMatch);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class SearchOptions {
	    query: string;
	    caseSensitive: boolean;
	    wholeWord: boolean;
	    regex: boolean;
	    maxResults: number;
	
	    static createFrom(source: any = {}) {
	        return new SearchOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.query = source["query"];
	        this.caseSensitive = source["caseSensitive"];
	        this.wholeWord = source["wholeWord"];
	        this.regex = source["regex"];
	        this.maxResults = source["maxResults"];
	    }
	}
	export class SearchResult {
	    files: SearchFileResult[];
	    total: number;
	    truncated: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SearchResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.files = this.convertValues(source["files"], SearchFileResult);
	        this.total = source["total"];
	        this.truncated = source["truncated"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Settings {
	    language: string;
	    defaultPrompt: string;
	    theme: string;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.language = source["language"];
	        this.defaultPrompt = source["defaultPrompt"];
	        this.theme = source["theme"];
	    }
	}
	export class VersionInfo {
	    version: string;
	    releaseDate: string;
	    downloadUrl: string;
	    sha256: string;
	    notes: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new VersionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.releaseDate = source["releaseDate"];
	        this.downloadUrl = source["downloadUrl"];
	        this.sha256 = source["sha256"];
	        this.notes = source["notes"];
	    }
	}
	export class UpdateCheck {
	    current: string;
	    available: boolean;
	    latest: VersionInfo;
	
	    static createFrom(source: any = {}) {
	        return new UpdateCheck(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.current = source["current"];
	        this.available = source["available"];
	        this.latest = this.convertValues(source["latest"], VersionInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

