import { Directive, Input, ElementRef, OnChanges, SecurityContext } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { PlatformService } from '../api/platform'

/** @hidden */
@Directive({
    selector: '[fastHtmlBind]',
})
export class FastHtmlBindDirective implements OnChanges {
    @Input() fastHtmlBind?: string

    constructor (
        private el: ElementRef,
        private platform: PlatformService,
        private sanitizer: DomSanitizer,
    ) { }

    ngOnChanges (): void {
        this.el.nativeElement.innerHTML = this.sanitizer.sanitize(SecurityContext.HTML, this.fastHtmlBind ?? '') ?? ''
        for (const link of this.el.nativeElement.querySelectorAll('a')) {
            link.addEventListener('click', event => {
                event.preventDefault()
                this.platform.openExternal(link.href)
            })
        }
    }
}
