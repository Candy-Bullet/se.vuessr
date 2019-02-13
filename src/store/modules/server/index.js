/**********************************************************
 * Copyright (c) SESHENGHUO.COM All rights reserved       *
 **********************************************************/

/**
 * 服务器Store配置
 * @charset utf-8
 * @author lijun
 * @git: https://github.com/zwlijun/se.vuessr
 * @date 2019.2
 */
'use strict';

import VUESSRContext from "~conf/server/context";
import {SEO, OGP} from "~lib/utils/head";

export default {
    namespaced: true,
    state() {
        return VUESSRContext;
    },
    mutations: {
        service(state, payload){
            state.service = payload;
        },
        title(state, payload){
            state.title = payload;
        },
        nonce(state, payload){
            state.nonce = payload;
        },
        client(state, payload){
            state.client = Object.assign((state.client || {}), payload);
        },
        server(state, payload){
            state.server = payload;
        },
        meta(state, payload){
            state.meta = payload;
        },
        seo(state, payload){
            state.seo = Object.assign((state.seo || {}), payload);
            state.seoMeta = SEO(state.seo);
        },
        ogp(state, payload){
            state.ogp = Object.assign((state.ogp || {}), payload);
            state.ogpMeta = OGP(state.ogp);
        }
    }
};