<template>
	<div id="nuage-de-mots">
		<div id="question">
			<div class="question-et-support" v-if="question !== '' && Object.keys(support).length > 0">
				<span class="question">{{ question }}</span>

				<span class="support" v-if="support.lien && support.lien !== ''" @click="afficherMedia($event, support.lien, 'video')" :title="$t('afficherSupport')"><img :src="support.vignette" :alt="support.vignette"></span>
				<span class="support" v-else-if="support.fichier && support.fichier !== '' && support.type === 'image'" @click="afficherMedia($event, '/fichiers/' + code + '/' + support.fichier, 'image')" :title="$t('afficherSupport')"><img :src="'/fichiers/' + code + '/' + support.fichier" :alt="support.alt"></span>
				<span class="support" v-else-if="support.fichier && support.fichier !== '' && support.type === 'audio'" @click="afficherMedia($event, '/fichiers/' + code + '/' + support.fichier, 'audio')" :title="$t('afficherSupport')"><span><i class="material-icons">audiotrack</i></span></span>
			</div>
			<div class="question" v-else-if="question !== ''">
				{{ question }}
			</div>
			<div class="support seul" v-else-if="Object.keys(support).length > 0">
				<img :src="support.vignette" :alt="support.vignette" v-if="support.lien && support.lien !== ''" @click="afficherMedia($event, support.lien, 'video')" :title="$t('afficherSupport')">
				<img :src="'/fichiers/' + code + '/' + support.fichier" :alt="support.alt" v-else-if="support.fichier && support.fichier !== '' && support.type === 'image'" @click="afficherMedia($event, '/fichiers/' + code + '/' + support.fichier, 'image')" :title="$t('afficherSupport')">
				<audio v-else-if="support.fichier && support.fichier !== '' && support.type === 'audio'" controls :src="'/fichiers/' + code + '/' + support.fichier" />
			</div>
		</div>

		<div id="mot">
			<div class="conteneur-textarea">
				<TextareaAutosize v-model="texte" :rows="2" :min-height="46" :max-height="124" :placeholder="$t('votreMot')" />
			</div>
			<div class="actions">
				<span class="bouton" role="button" tabindex="0" @click="envoyerReponse" v-if="statut !== 'verrouille'">{{ $t('envoyer') }}</span>
				<span class="bouton desactive" role="button" tabindex="0" v-else>{{ $t('envoyer') }}</span>
			</div>
		</div>

		<div id="mots" v-if="mots.length > 0">
			<h3 v-if="mots.length === 1">{{ $t('motEnvoye') }}</h3>
			<h3 v-else>{{ $t('motsEnvoyes') }}</h3>
			<ul>
				<li v-for="(mot, indexMot) in mots" :key="'mot_' + indexMot">
					<span v-if="mot.visible">{{ mot.texte }}</span>
					<span v-else><del>{{ mot.texte }}</del></span>
				</li>
			</ul>
		</div>

		<div class="conteneur-modale" role="dialog" tabindex="-1" v-if="modale === 'nuage'">
			<div id="modale-nuage" class="modale" role="document">
				<div class="conteneur">
					<div class="contenu">
						<vue-word-cloud :animation-duration="350" animation-easing="ease-in-out" :animation-overlap="1" color="#00ced1" font-family="HKGrotesk-ExtraBold" :spacing="1/2" :words="nuage" @update:progress="modifierProgression">
							<template v-slot="{text, weight}">
								<div :title="text + ' (' + weight + ')'">
									{{ text }}
								</div>
							</template>
						</vue-word-cloud>
					</div>
				</div>
			</div>
		</div>

		<Chargement v-if="chargement" />
	</div>
</template>

<script>
import latinise from 'voca/latinise'
import Chargement from '#root/components/chargement.vue'
import TextareaAutosize from '#root/components/textareaAutosize.vue'
import VueWordCloud from '#root/components/wordcloud'

export default {
	name: 'NuageMotsParticiper',
	components: {
		Chargement,
		TextareaAutosize,
		[VueWordCloud.name]: VueWordCloud
	},
	props: {
		hote: String,
		identifiant: String,
		nom: String,
		code: String,
		donnees: Object,
		reponses: Array,
		statut: String,
		session: Number
	},
	data () {
		return {
			chargement: false,
			question: '',
			support: {},
			options: {},
			texte: '',
			nuage: [],
			modale: '',
			progression: ''
		}
	},
	computed: {
		mots () {
			const mots = []
			this.reponses.forEach(function (item) {
				if (item.identifiant === this.identifiant) {
					mots.push({ texte: item.reponse.texte, visible: item.reponse.visible })
				}
			}.bind(this))
			return mots
		}
	},
	watch: {
		reponses: {
			handler (reponses) {
				if (this.statut === 'nuage-affiche') {
					this.definirNuage(reponses)
				}
			},
			deep: true
		},
		progression: function (progression) {
			if (progression === '' || progression === null) {
				this.chargement = true
				setTimeout(function () {
					this.chargement = false
				}.bind(this), 350)
			} else {
				setTimeout(function () {
					this.chargement = false
				}.bind(this), 350)
			}
		}
	},
	created () {
		this.ecouterSocket()
		this.question = this.donnees.question
		this.support = this.donnees.support
		if (this.donnees.hasOwnProperty('options')) {
			this.options = this.donnees.options
		}
		if (this.statut === 'nuage-affiche') {
			this.definirNuage(this.reponses)
		}
	},
	mounted () {
		if (this.statut === 'nuage-affiche') {
			this.modale = 'nuage'
		}
	},
	methods: {
		definirNuage (reponses) {
			const nuage = []
			reponses.forEach(function (item) {
				if (item.reponse.visible && (Object.keys(this.options).length === 0 || (this.options.hasOwnProperty('casse') && this.options.casse === 'non'))) {
					if (nuage.map(mot => mot.text).includes(item.reponse.texte) === true) {
						nuage.forEach(function (mot, indexMot) {
							if (mot.text === item.reponse.texte) {
								nuage[indexMot].weight = mot.weight + 1
							}
						})
					} else {
						const id = Math.random().toString(16).slice(3)
						nuage.push({ id: id, text: item.reponse.texte, weight: 1, number: 1, rotation: 0, fontFamily: 'HKGrotesk-ExtraBold', color: item.reponse.couleur })
					}
				} else if (item.reponse.visible && this.options.hasOwnProperty('casse') && this.options.casse === 'oui') {
					if (nuage.map(mot => latinise(mot.text.toLowerCase())).includes(latinise(item.reponse.texte.toLowerCase())) === true) {
						nuage.forEach(function (mot, indexMot) {
							if (latinise(mot.text.toLowerCase()) === latinise(item.reponse.texte.toLowerCase())) {
								nuage[indexMot].weight = mot.weight + 1
							}
						})
					} else {
						const id = Math.random().toString(16).slice(3)
						nuage.push({ id: id, text: item.reponse.texte, weight: 1, number: 1, rotation: 0, fontFamily: 'HKGrotesk-ExtraBold', color: item.reponse.couleur })
					}
				}
			}.bind(this))
			this.nuage = nuage
		},
		modifierProgression (progression) {
			this.progression = progression
		},
		envoyerReponse () {
			if (this.texte.trim() !== '') {
				this.chargement = true
				const couleurs = ['#ffd077', '#3bc4c7', '#3a9eea', '#ff4e69', '#461e47']
				const couleur = couleurs[Math.floor(Math.random() * couleurs.length)]
				this.$socket.emit('reponse', { code: this.code, session: this.session, donnees: { reponse: { texte: this.texte.trim(), couleur: couleur, visible: true }, identifiant: this.identifiant, nom: this.nom } })
				this.texte = ''
			}
		},
		afficherMedia (event, media, type) {
			this.$emit('media', event, media, type)
		},
		ecouterSocket () {
			this.$socket.on('reponseenvoyee', function () {
				this.chargement = false
				this.texte = ''
			}.bind(this))

			this.$socket.on('nuageaffiche', function () {
				this.definirNuage(this.reponses)
				this.modale = 'nuage'
			}.bind(this))

			this.$socket.on('nuagemasque', function () {
				this.nuage = []
				if (this.modale === 'nuage') {
					this.modale = ''
				}
			}.bind(this))
		}
	}
}
</script>

<style scoped src="#root/components/css/style-participer.css"></style>

<style scoped>
#mot .conteneur-textarea {
    position: relative;
    min-height: 46px;
    max-height: 124px;
}

#mot .conteneur-textarea > textarea {
	display: block;
    width: 100%;
    font-weight: 400;
    font-size: 16px;
    text-align: left;
    border-radius: 4px;
    cursor: text;
    background: #fff;
    resize: none;
    max-width: 100%;
    border: 1px solid #ddd;
    padding: 10px 15px;
}

#mots > h3 {
	font-size: 16px;
    font-weight: 700;
    display: block;
    margin: 20px 0 10px;
}

#mot .actions {
	text-align: center;
	margin-top: 5px;
}

#mot .bouton {
	display: inline-block;
	font-weight: 700;
	font-size: 18px;
	text-transform: uppercase;
	height: 40px;
	line-height: 40px;
	padding: 0 50px;
	cursor: pointer;
	color: #fff;
	text-shadow: 1px 1px 1px rgba(0, 0, 0, 0.3);
	background: #009688;
	border-radius: 2em;
	letter-spacing: 1px;
	text-indent: 1px;
	transition: all 0.1s ease-in;
}

#mot .bouton:hover {
	background: #00a695;
}

#mot .bouton.desactive:hover,
#mot .bouton.desactive {
	background: #aaa!important;
}

#mot .conteneur-textarea + .actions {
	margin-top: 20px;
}

#mots {
	margin-top: 40px;
	margin-bottom: 30px;
}

#mots ul {
	padding: 5px 0 0;
}

#mots li {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 5px 10px;
	background: #eee;
	border-radius: 4px;
	margin-bottom: 10px;
	font-size: 16px;
	font-weight: 400;
}

#modale-nuage {
	height: 90%;
	width: 95%;
	max-width: 95%;
}

#modale-nuage .conteneur,
#modale-nuage .contenu {
	height: 100%;
}
</style>
