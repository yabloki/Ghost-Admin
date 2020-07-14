import Ember from 'ember';
import Model, {attr, belongsTo, hasMany} from '@ember-data/model';
import ValidationEngine from 'ghost-admin/mixins/validation-engine';
import boundOneWay from 'ghost-admin/utils/bound-one-way';
import moment from 'moment';
import {compare} from '@ember/utils';
// eslint-disable-next-line ghost/ember/no-observers
import {computed, observer} from '@ember/object';
import {equal, filterBy, reads} from '@ember/object/computed';
import {isBlank} from '@ember/utils';
import {on} from '@ember/object/evented';
import {inject as service} from '@ember/service';

// ember-cli-shims doesn't export these so we must get them manually
const {Comparable} = Ember;

function statusCompare(postA, postB) {
    let status1 = postA.get('status');
    let status2 = postB.get('status');

    // if any of those is empty
    if (!status1 && !status2) {
        return 0;
    }

    if (!status1 && status2) {
        return -1;
    }

    if (!status2 && status1) {
        return 1;
    }

    // We have to make sure, that scheduled posts will be listed first
    // after that, draft and published will be sorted alphabetically and don't need
    // any manual comparison.

    if (status1 === 'scheduled' && (status2 === 'draft' || status2 === 'published')) {
        return -1;
    }

    if (status2 === 'scheduled' && (status1 === 'draft' || status1 === 'published')) {
        return 1;
    }

    return compare(status1.valueOf(), status2.valueOf());
}

function publishedAtCompare(postA, postB) {
    let published1 = postA.get('publishedAtUTC');
    let published2 = postB.get('publishedAtUTC');

    if (!published1 && !published2) {
        return 0;
    }

    if (!published1 && published2) {
        return -1;
    }

    if (!published2 && published1) {
        return 1;
    }

    return compare(published1.valueOf(), published2.valueOf());
}

export default Model.extend(Comparable, ValidationEngine, {
    config: service(),
    feature: service(),
    ghostPaths: service(),
    clock: service(),
    settings: service(),

    displayName: 'post',
    validationType: 'post',

    createdAtUTC: attr('moment-utc'),
    excerpt: attr('string'),
    customExcerpt: attr('string'),
    featured: attr('boolean', {defaultValue: false}),
    featureImage: attr('string'),
    canonicalUrl: attr('string'),
    commentPrice: attr('string'),
    codeinjectionFoot: attr('string', {defaultValue: ''}),
    codeinjectionHead: attr('string', {defaultValue: ''}),
    customTemplate: attr('string'),
    ogImage: attr('string'),
    ogTitle: attr('string'),
    ogDescription: attr('string'),
    twitterImage: attr('string'),
    twitterTitle: attr('string'),
    twitterDescription: attr('string'),
    emailSubject: attr('string'),
    html: attr('string'),
    locale: attr('string'),
    visibility: attr('string'),
    metaDescription: attr('string'),
    metaTitle: attr('string'),
    mobiledoc: attr('json-string'),
    plaintext: attr('string'),
    publishedAtUTC: attr('moment-utc'),
    slug: attr('string'),
    status: attr('string', {defaultValue: 'draft'}),
    title: attr('string', {defaultValue: ''}),
    updatedAtUTC: attr('moment-utc'),
    updatedBy: attr('number'),
    url: attr('string'),
    uuid: attr('string'),
    sendEmailWhenPublished: attr('boolean', {defaultValue: false}),

    authors: hasMany('user', {embedded: 'always', async: false}),
    createdBy: belongsTo('user', {async: true}),
    email: belongsTo('email', {async: false}),
    publishedBy: belongsTo('user', {async: true}),
    tags: hasMany('tag', {embedded: 'always', async: false}),

    primaryAuthor: reads('authors.firstObject'),

    scratch: null,
    titleScratch: null,

    // HACK: used for validation so that date/time can be validated based on
    // eventual status rather than current status
    statusScratch: null,

    // For use by date/time pickers - will be validated then converted to UTC
    // on save. Updated by an observer whenever publishedAtUTC changes.
    // Everything that revolves around publishedAtUTC only cares about the saved
    // value so this should be almost entirely internal
    publishedAtBlogDate: '',
    publishedAtBlogTime: '',

    canonicalUrlScratch: boundOneWay('canonicalUrl'),
    customExcerptScratch: boundOneWay('customExcerpt'),
    codeinjectionFootScratch: boundOneWay('codeinjectionFoot'),
    codeinjectionHeadScratch: boundOneWay('codeinjectionHead'),
    metaDescriptionScratch: boundOneWay('metaDescription'),
    metaTitleScratch: boundOneWay('metaTitle'),
    ogDescriptionScratch: boundOneWay('ogDescription'),
    ogTitleScratch: boundOneWay('ogTitle'),
    twitterDescriptionScratch: boundOneWay('twitterDescription'),
    twitterTitleScratch: boundOneWay('twitterTitle'),

    emailSubjectScratch: boundOneWay('emailSubject'),

    isPublished: equal('status', 'published'),
    isDraft: equal('status', 'draft'),
    internalTags: filterBy('tags', 'isInternal', true),
    isScheduled: equal('status', 'scheduled'),

    previewUrl: computed('uuid', 'ghostPaths.url', 'config.blogUrl', function () {
        let blogUrl = this.get('config.blogUrl');
        let uuid = this.uuid;
        // routeKeywords.preview: 'p'
        let previewKeyword = 'p';
        // New posts don't have a preview
        if (!uuid) {
            return '';
        }
        return this.get('ghostPaths.url').join(blogUrl, previewKeyword, uuid);
    }),

    // check every second to see if we're past the scheduled time
    // will only re-compute if this property is being observed elsewhere
    pastScheduledTime: computed('isScheduled', 'publishedAtUTC', 'clock.second', function () {
        if (this.isScheduled) {
            let now = moment.utc();
            let publishedAtUTC = this.publishedAtUTC || now;
            let pastScheduledTime = publishedAtUTC.diff(now, 'hours', true) < 0;

            // force a recompute
            this.get('clock.second');

            return pastScheduledTime;
        } else {
            return false;
        }
    }),

    publishedAtBlogTZ: computed('publishedAtBlogDate', 'publishedAtBlogTime', 'settings.activeTimezone', {
        get() {
            return this._getPublishedAtBlogTZ();
        },
        set(key, value) {
            let momentValue = value ? moment(value) : null;
            this._setPublishedAtBlogStrings(momentValue);
            return this._getPublishedAtBlogTZ();
        }
    }),

    _getPublishedAtBlogTZ() {
        let publishedAtUTC = this.publishedAtUTC;
        let publishedAtBlogDate = this.publishedAtBlogDate;
        let publishedAtBlogTime = this.publishedAtBlogTime;
        let blogTimezone = this.get('settings.activeTimezone');

        if (!publishedAtUTC && isBlank(publishedAtBlogDate) && isBlank(publishedAtBlogTime)) {
            return null;
        }

        if (publishedAtBlogDate && publishedAtBlogTime) {
            let publishedAtBlog = moment.tz(`${publishedAtBlogDate} ${publishedAtBlogTime}`, blogTimezone);

            /**
             * Note:
             * If you create a post and publish it, we send seconds to the database.
             * If you edit the post afterwards, ember would send the date without seconds, because
             * the `publishedAtUTC` is based on `publishedAtBlogTime`, which is only in seconds.
             * The date time picker doesn't use seconds.
             *
             * This condition prevents the case:
             *   - you edit a post, but you don't change the published_at time
             *   - we keep the original date with seconds
             *
             * See https://github.com/TryGhost/Ghost/issues/8603#issuecomment-309538395.
             */
            if (publishedAtUTC && publishedAtBlog.diff(publishedAtUTC.clone().startOf('minutes')) === 0) {
                return publishedAtUTC;
            }

            return publishedAtBlog;
        } else {
            return moment.tz(this.publishedAtUTC, blogTimezone);
        }
    },

    // TODO: is there a better way to handle this?
    // eslint-disable-next-line ghost/ember/no-observers
    _setPublishedAtBlogTZ: on('init', observer('publishedAtUTC', 'settings.activeTimezone', function () {
        let publishedAtUTC = this.publishedAtUTC;
        this._setPublishedAtBlogStrings(publishedAtUTC);
    })),

    _setPublishedAtBlogStrings(momentDate) {
        if (momentDate) {
            let blogTimezone = this.get('settings.activeTimezone');
            let publishedAtBlog = moment.tz(momentDate, blogTimezone);

            this.set('publishedAtBlogDate', publishedAtBlog.format('YYYY-MM-DD'));
            this.set('publishedAtBlogTime', publishedAtBlog.format('HH:mm'));
        } else {
            this.set('publishedAtBlogDate', '');
            this.set('publishedAtBlogTime', '');
        }
    },

    // remove client-generated tags, which have `id: null`.
    // Ember Data won't recognize/update them automatically
    // when returned from the server with ids.
    // https://github.com/emberjs/data/issues/1829
    updateTags() {
        let tags = this.tags;
        let oldTags = tags.filterBy('id', null);

        tags.removeObjects(oldTags);
        oldTags.invoke('deleteRecord');
    },

    isAuthoredByUser(user) {
        return this.authors.includes(user);
    },

    // a custom sort function is needed in order to sort the posts list the same way the server would:
    //     status: scheduled, draft, published
    //     publishedAt: DESC
    //     updatedAt: DESC
    //     id: DESC
    compare(postA, postB) {
        let updated1 = postA.get('updatedAtUTC');
        let updated2 = postB.get('updatedAtUTC');
        let idResult,
            publishedAtResult,
            statusResult,
            updatedAtResult;

        // when `updatedAt` is undefined, the model is still
        // being written to with the results from the server
        if (postA.get('isNew') || !updated1) {
            return -1;
        }

        if (postB.get('isNew') || !updated2) {
            return 1;
        }

        // TODO: revisit the ID sorting because we no longer have auto-incrementing IDs
        idResult = compare(postA.get('id'), postB.get('id'));
        statusResult = statusCompare(postA, postB);
        updatedAtResult = compare(updated1.valueOf(), updated2.valueOf());
        publishedAtResult = publishedAtCompare(postA, postB);

        if (statusResult === 0) {
            if (publishedAtResult === 0) {
                if (updatedAtResult === 0) {
                    // This should be DESC
                    return idResult * -1;
                }
                // This should be DESC
                return updatedAtResult * -1;
            }
            // This should be DESC
            return publishedAtResult * -1;
        }

        return statusResult;
    },

    // this is a hook added by the ValidationEngine mixin and is called after
    // successful validation and before this.save()
    //
    // the publishedAtBlog{Date/Time} strings are set separately so they can be
    // validated, grab that time if it exists and set the publishedAtUTC
    beforeSave() {
        let publishedAtBlogTZ = this.publishedAtBlogTZ;
        let publishedAtUTC = publishedAtBlogTZ ? publishedAtBlogTZ.utc() : null;
        this.set('publishedAtUTC', publishedAtUTC);
    }
});
