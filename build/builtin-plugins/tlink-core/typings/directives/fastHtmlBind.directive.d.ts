import { ElementRef, OnChanges } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { PlatformService } from '../api/platform';
/** @hidden */
export declare class FastHtmlBindDirective implements OnChanges {
    private el;
    private platform;
    private sanitizer;
    fastHtmlBind?: string;
    constructor(el: ElementRef, platform: PlatformService, sanitizer: DomSanitizer);
    ngOnChanges(): void;
}
