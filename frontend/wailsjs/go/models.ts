export namespace main {
	
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
	export class Settings {
	    language: string;
	    defaultPrompt: string;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.language = source["language"];
	        this.defaultPrompt = source["defaultPrompt"];
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

