import 'dotenv/config'
import path from 'path'
import fs from 'fs-extra'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import compression from 'compression'
import axios from 'axios'
import cors from 'cors'
import redis from 'redis'
import bodyParser from 'body-parser'
import helmet from 'helmet'
import v from 'voca'
import multer from 'multer'
import PDFDocument from 'pdfkit'
import sharp from 'sharp'
import archiver from 'archiver'
import extract from 'extract-zip'
import dayjs from 'dayjs'
import 'dayjs/locale/es.js'
import 'dayjs/locale/fr.js'
import 'dayjs/locale/it.js'
import localizedFormat from 'dayjs/plugin/localizedFormat.js'
import bcrypt from 'bcrypt'
import cron from 'node-cron'
import nodemailer from 'nodemailer'
import { fileURLToPath } from 'url'
import connectRedis from 'connect-redis'
import session from 'express-session'
import { renderPage } from 'vike/server'
// Charger strings langues
import t from './lang.js'

const production = process.env.NODE_ENV === 'production'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = `${__dirname}/..`

// Vérifier si un buffer est une image jpg, png ou gif (pour PDFKit)
const magic = ['ffd8ffe0', '89504e47', '47494638']

demarrerServeur()

async function demarrerServeur () {
	const app = express()
	app.use(compression())
	const httpServer = createServer(app)
	const RedisStore = connectRedis(session)

	let hote = 'http://localhost:3000'
	if (process.env.PORT) {
		hote = 'http://localhost:' + process.env.PORT
	}
	if (production) {
		hote = process.env.DOMAIN
	}
	let db
	let db_port = 6379
	if (process.env.DB_PORT) {
		db_port = process.env.DB_PORT
	}
	if (production) {
		db = redis.createClient({ host: process.env.DB_HOST, port: db_port, password: process.env.DB_PWD })
	} else {
		db = redis.createClient({ port: db_port })
	}

	let storeOptions, cookie, dureeSession, domainesAutorises
	if (production) {
		storeOptions = {
			host: process.env.DB_HOST,
			port: db_port,
			pass: process.env.DB_PWD,
			client: db,
			prefix: 'sessions:'
		}
		cookie = {
			sameSite: 'None',
			secure: true
		}
	} else {
		storeOptions = {
			host: 'localhost',
			port: db_port,
			client: db,
			prefix: 'sessions:'
		}
		cookie = {
			secure: false
		}
	}
	const sessionOptions = {
		secret: process.env.SESSION_KEY,
		store: new RedisStore(storeOptions),
		name: 'digistorm',
		resave: false,
		rolling: true,
		saveUninitialized: false,
		cookie: cookie
	}
	if (process.env.SESSION_DURATION) {
		dureeSession = parseInt(process.env.SESSION_DURATION)
	} else {
		dureeSession = 864000000 //3600 * 24 * 10 * 1000
	}
	const sessionMiddleware = session(sessionOptions)

	if (production && process.env.AUTHORIZED_DOMAINS) {
		domainesAutorises = process.env.AUTHORIZED_DOMAINS.split(',')
	} else {
		domainesAutorises = '*'
	}

	const transporter = nodemailer.createTransport({
		host: process.env.EMAIL_HOST,
		port: process.env.EMAIL_PORT,
		secure: process.env.EMAIL_SECURE,
		auth: {
			user: process.env.EMAIL_ADDRESS,
			pass: process.env.EMAIL_PASSWORD
		}
	})

	cron.schedule('59 23 * * Saturday', async function () {
		await fs.emptyDir(path.join(__dirname, '..', '/static/temp'))
	})

	// Charger plugin dayjs
	dayjs.extend(localizedFormat)

	app.set('trust proxy', true)
	app.use(
		helmet.contentSecurityPolicy({
			directives: {
				"default-src": ["'self'", "https:", "ws:", "data:"],
				"script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'", "blob:", 'https://cdn.jsdelivr.net'],
				"media-src": ["'self'", "https:", "data:"],
				"img-src": ["'self'", "https:", "data:"],
				"frame-ancestors": ["*"],
				"frame-src": ["*", "blob:"]
			}
		})
	)
	app.use(bodyParser.json({ limit: '10mb' }))
	app.use(sessionMiddleware)
	app.use(cors({ 'origin': domainesAutorises }))
	app.use('/', express.static('static'))

	if (production) {
		const sirv = (await import('sirv')).default
		app.use(sirv(`${root}/dist/client`))
	} else {
    	const vite = await import('vite')
    	const viteDevMiddleware = (
      		await vite.createServer({
        		root,
        		server: { middlewareMode: true }
			})
    	).middlewares
    	app.use(viteDevMiddleware)
  	}

	app.get('/', async function (req, res, next) {
		if (req.session.identifiant && req.session.role === 'utilisateur') {
			res.redirect('/u/' + req.session.identifiant)
		} else {
			let langue = 'en'
			if (req.session.hasOwnProperty('langue') && req.session.langue !== '') {
				langue = req.session.langue
			}
			const pageContextInit = {
				urlOriginal: req.originalUrl,
				params: req.query,
				hote: hote,
				langues: ['fr', 'es', 'it', 'en'],
				langue: langue
			}
			const pageContext = await renderPage(pageContextInit)
			const { httpResponse } = pageContext
			if (!httpResponse) {
				return next()
			}
			const { body, statusCode, headers, earlyHints } = httpResponse
			if (res.writeEarlyHints) {
				res.writeEarlyHints({ link: earlyHints.map((e) => e.earlyHintLink) })
			}
			if (headers) {
				headers.forEach(([name, value]) => res.setHeader(name, value))
			}
			res.status(statusCode).send(body)
		}
	})

	app.get('/u/:utilisateur', async function (req, res, next) {
		const identifiant = req.params.utilisateur
		if (identifiant === req.session.identifiant && req.session.role === 'utilisateur') {
			const pageContextInit = {
				urlOriginal: req.originalUrl,
				params: req.query,
				hote: hote,
				langues: ['fr', 'es', 'it', 'en'],
				identifiant: req.session.identifiant,
				nom: req.session.nom,
				email: req.session.email,
				langue: req.session.langue,
				role: req.session.role
			}
			const pageContext = await renderPage(pageContextInit)
			const { httpResponse } = pageContext
			if (!httpResponse) {
				return next()
			}
			const { body, statusCode, headers, earlyHints } = httpResponse
			if (res.writeEarlyHints) {
				res.writeEarlyHints({ link: earlyHints.map((e) => e.earlyHintLink) })
			}
			if (headers) {
				headers.forEach(([name, value]) => res.setHeader(name, value))
			}
			res.status(statusCode).send(body)
		} else {
			res.redirect('/')
		}
	})

	app.get('/c/:code', async function (req, res, next) {
		if (!req.query.id && !req.query.mdp && (req.session.identifiant === '' || req.session.identifiant === undefined)) {
			const identifiant = 'u' + Math.random().toString(16).slice(3)
			req.session.identifiant = identifiant
			req.session.nom = ''
			req.session.email = ''
			req.session.langue = 'en'
			req.session.role = 'invite'
			req.session.interactions = []
			req.session.digidrive = []
			req.session.cookie.expires = new Date(Date.now() + dureeSession)
		}
		if (!req.query.id && !req.query.mdp && !req.session.hasOwnProperty('interactions')) {
			req.session.pads = []
		}
		if (!req.query.id && !req.query.mdp && !req.session.hasOwnProperty('digidrive')) {
			req.session.digidrive = []
		}
		const pageContextInit = {
			urlOriginal: req.originalUrl,
			params: req.query,
			hote: hote,
			langues: ['fr', 'es', 'it', 'en'],
			identifiant: req.session.identifiant,
			nom: req.session.nom,
			email: req.session.email,
			langue: req.session.langue,
			role: req.session.role,
			interactions: req.session.interactions,
			digidrive: req.session.digidrive
		}
		const pageContext = await renderPage(pageContextInit)
		const { httpResponse } = pageContext
		if (!httpResponse) {
			return next()
		}
		const { body, statusCode, headers, earlyHints } = httpResponse
		if (res.writeEarlyHints) {
			res.writeEarlyHints({ link: earlyHints.map((e) => e.earlyHintLink) })
		}
		if (headers) {
			headers.forEach(([name, value]) => res.setHeader(name, value))
		}
		res.status(statusCode).send(body)
	})

	app.get('/p/:code', async function (req, res, next) {
		if (req.session.identifiant === '' || req.session.identifiant === undefined) {
			const identifiant = 'u' + Math.random().toString(16).slice(3)
			req.session.identifiant = identifiant
			req.session.nom = ''
			req.session.email = ''
			req.session.langue = 'en'
			req.session.role = 'invite'
			req.session.interactions = []
			req.session.digidrive = []
			req.session.cookie.expires = new Date(Date.now() + dureeSession)
		}
		if (!req.session.hasOwnProperty('interactions')) {
			req.session.pads = []
		}
		if (!req.session.hasOwnProperty('digidrive')) {
			req.session.digidrive = []
		}
		const pageContextInit = {
			urlOriginal: req.originalUrl,
			params: req.query,
			hote: hote,
			langues: ['fr', 'es', 'it', 'en'],
			identifiant: req.session.identifiant,
			nom: req.session.nom,
			langue: req.session.langue
		}
		const pageContext = await renderPage(pageContextInit)
		const { httpResponse } = pageContext
		if (!httpResponse) {
			return next()
		}
		const { body, statusCode, headers, earlyHints } = httpResponse
		if (res.writeEarlyHints) {
			res.writeEarlyHints({ link: earlyHints.map((e) => e.earlyHintLink) })
		}
		if (headers) {
			headers.forEach(([name, value]) => res.setHeader(name, value))
		}
		res.status(statusCode).send(body)
	})

	app.get('/admin', async function (req, res, next) {
		let langue = 'en'
		if (req.session.hasOwnProperty('langue') && req.session.langue !== '') {
			langue = req.session.langue
		}
		const pageContextInit = {
			urlOriginal: req.originalUrl,
			hote: hote,
			langue: langue
		}
		const pageContext = await renderPage(pageContextInit)
		const { httpResponse } = pageContext
		if (!httpResponse) {
			return next()
		}
		const { body, statusCode, headers, earlyHints } = httpResponse
		if (res.writeEarlyHints) {
			res.writeEarlyHints({ link: earlyHints.map((e) => e.earlyHintLink) })
		}
		if (headers) {
			headers.forEach(([name, value]) => res.setHeader(name, value))
		}
		res.status(statusCode).send(body)
  	})

	app.post('/api/s-inscrire', function (req, res) {
		const identifiant = req.body.identifiant
		const motdepasse = req.body.motdepasse
		const email = req.body.email
		let langue = 'en'
		if (req.session && req.session.hasOwnProperty('langue') && req.session.langue !== '') {
			langue = req.session.langue
		}
		db.exists('utilisateurs:' + identifiant, async function (err, reponse) {
			if (err) { res.send('erreur') }
			if (reponse === 0) {
				const hash = await bcrypt.hash(motdepasse, 10)
				const date = dayjs().format()
				const multi = db.multi()
				multi.hmset('utilisateurs:' + identifiant, 'id', identifiant, 'email', email, 'motdepasse', hash, 'date', date, 'nom', '', 'langue', langue)
				multi.exec(function () {
					req.session.identifiant = identifiant
					req.session.nom = ''
					req.session.email = email
					if (req.session.langue === '' || req.session.langue === undefined) {
						req.session.langue = 'en'
					}
					req.session.role = 'utilisateur'
					req.session.cookie.expires = new Date(Date.now() + dureeSession)
					res.json({ identifiant: identifiant })
				})
			} else {
				res.send('utilisateur_existe_deja')
			}
		})
	})

	app.post('/api/se-connecter', function (req, res) {
		const identifiant = req.body.identifiant
		const motdepasse = req.body.motdepasse
		db.exists('utilisateurs:' + identifiant, function (err, reponse) {
			if (err) { res.send('erreur_connexion'); return false }
			if (reponse === 1) {
				db.hgetall('utilisateurs:' + identifiant, async function (err, donnees) {
					if (err) { res.send('erreur_connexion'); return false }
					let comparaison = false
					if (motdepasse.trim() !== '' && donnees.hasOwnProperty('motdepasse') && donnees.motdepasse.trim() !== '') {
						comparaison = await bcrypt.compare(motdepasse, donnees.motdepasse)
					}
					let comparaisonTemp = false
					if (donnees.hasOwnProperty('motdepassetemp') && donnees.motdepassetemp.trim() !== '' && motdepasse.trim() !== '') {
						comparaisonTemp = await bcrypt.compare(motdepasse, donnees.motdepassetemp)
					}
					if (comparaison === true || comparaisonTemp === true) {
						if (comparaisonTemp === true) {
							const hash = await bcrypt.hash(motdepasse, 10)
							db.hset('utilisateurs:' + identifiant, 'motdepasse', hash)
							db.hdel('utilisateurs:' + identifiant, 'motdepassetemp')
						}
						const nom = donnees.nom
						const langue = donnees.langue
						req.session.identifiant = identifiant
						req.session.nom = nom
						req.session.langue = langue
						req.session.role = 'utilisateur'
						req.session.cookie.expires = new Date(Date.now() + dureeSession)
						let email = ''
						if (donnees.hasOwnProperty('email')) {
							email = donnees.email
						}
						req.session.email = email
						res.json({ identifiant: identifiant })
					} else {
						res.send('erreur_connexion')
					}
				})
			} else {
				res.send('erreur_connexion')
			}
		})
	})

	app.post('/api/mot-de-passe-oublie', function (req, res) {
		const identifiant = req.body.identifiant
		let email = req.body.email.trim()
		db.exists('utilisateurs:' + identifiant, function (err, reponse) {
			if (err) { res.send('erreur'); return false }
			if (reponse === 1) {
				db.hgetall('utilisateurs:' + identifiant, function (err, donnees) {
					if ((donnees.hasOwnProperty('email') && donnees.email === email) || (verifierEmail(identifiant) === true)) {
						if (!donnees.hasOwnProperty('email') || (donnees.hasOwnProperty('email') && donnees.email === '')) {
							email = identifiant
						}
						const motdepasse = genererMotDePasse(7)
						const message = {
							from: '"La Digitale" <' + process.env.EMAIL_ADDRESS + '>',
							to: '"Moi" <' + email + '>',
							subject: 'Mot de passe Digistorm',
							html: '<p>Votre nouveau mot de passe : ' + motdepasse + '</p>'
						}
						transporter.sendMail(message, async function (err) {
							if (err) {
								res.send('erreur')
							} else {
								const hash = await bcrypt.hash(motdepasse, 10)
								db.hset('utilisateurs:' + identifiant, 'motdepassetemp', hash)
								res.send('message_envoye')
							}
						})
					} else {
						res.send('email_invalide')
					}
				})
			} else {
				res.send('identifiant_invalide')
			}
		})
	})

	app.post('/api/se-deconnecter', function (req, res) {
		req.session.identifiant = ''
		req.session.nom = ''
		req.session.email = ''
		req.session.langue = ''
		req.session.role = ''
		req.session.interactions = []
		req.session.destroy()
		res.send('deconnecte')
	})

	app.post('/api/recuperer-donnees-utilisateur', function (req, res) {
		const identifiant = req.body.identifiant
		recupererDonnees(identifiant).then(function (resultat) {
			res.json({ interactions: resultat[0], filtre: resultat[1] })
		})
	})

	app.post('/api/modifier-langue', function (req, res) {
		const langue = req.body.langue
		req.session.langue = langue
		res.send('langue_modifiee')
	})

	app.post('/api/modifier-nom', function (req, res) {
		const nom = req.body.nom
		req.session.nom = nom
		res.send('nom_modifie')
	})

	app.post('/api/modifier-filtre', function (req, res) {
		const identifiant = req.body.identifiant
		if (req.session.identifiant && req.session.identifiant === identifiant) {
			const filtre = req.body.filtre
			db.hset('utilisateurs:' + identifiant, 'filtre', filtre)
			res.send('filtre_modifie')
		} else {
			res.send('non_connecte')
		}
	})

	app.post('/api/modifier-informations-utilisateur', function (req, res) {
		const identifiant = req.body.identifiant
		if (req.session.identifiant && req.session.identifiant === identifiant) {
			const nom = req.body.nom
			const email = req.body.email
			db.hmset('utilisateurs:' + identifiant, 'nom', nom, 'email', email)
			req.session.nom = nom
			req.session.email = email
			res.send('utilisateur_modifie')
		} else {
			res.send('non_connecte')
		}
	})

	app.post('/api/modifier-mot-de-passe-utilisateur', function (req, res) {
		const identifiant = req.body.identifiant
		if (req.session.identifiant && req.session.identifiant === identifiant) {
			db.hgetall('utilisateurs:' + identifiant, async function (err, donnees) {
				if (err) { res.send('erreur'); return false }
				const motdepasse = req.body.motdepasse
				const nouveaumotdepasse = req.body.nouveaumotdepasse
				if (motdepasse.trim() !== '' && nouveaumotdepasse.trim() !== '' && donnees.hasOwnProperty('motdepasse') && donnees.motdepasse.trim() !== '' && await bcrypt.compare(motdepasse, donnees.motdepasse)) {
					const hash = await bcrypt.hash(nouveaumotdepasse, 10)
					db.hset('utilisateurs:' + identifiant, 'motdepasse', hash)
					res.send('motdepasse_modifie')
				} else {
					res.send('motdepasse_incorrect')
				}
			})
		} else {
			res.send('non_connecte')
		}
	})

	app.post('/api/modifier-mot-de-passe-admin', function (req, res) {
		const admin = req.body.admin
		if (admin !== '' && admin === process.env.VITE_ADMIN_PASSWORD) {
			const identifiant = req.body.identifiant
			const email = req.body.email
			if (identifiant !== '') {
				db.exists('utilisateurs:' + identifiant, async function (err, resultat) {
					if (err) { res.send('erreur'); return false }
					if (resultat === 1) {
						const hash = await bcrypt.hash(req.body.motdepasse, 10)
						db.hset('utilisateurs:' + identifiant, 'motdepasse', hash)
						res.send('motdepasse_modifie')
					} else {
						res.send('identifiant_non_valide')
					}
				})
			} else if (email !== '') {
				db.keys('utilisateurs:*', function (err, utilisateurs) {
					if (utilisateurs !== null) {
						const donneesUtilisateurs = []
						utilisateurs.forEach(function (utilisateur) {
							const donneesUtilisateur = new Promise(function (resolve) {
								db.hgetall('utilisateurs:' + utilisateur.substring(13), function (err, donnees) {
									if (err) { resolve({}); return false }
									if (donnees.hasOwnProperty('email')) {
										resolve({ identifiant: utilisateur.substring(13), email: donnees.email })
									} else {
										resolve({})
									}
								})
							})
							donneesUtilisateurs.push(donneesUtilisateur)
						})
						Promise.all(donneesUtilisateurs).then(async function (donnees) {
							let utilisateurId = ''
							donnees.forEach(function (utilisateur) {
								if (utilisateur.hasOwnProperty('email') && utilisateur.email.toLowerCase() === email.toLowerCase()) {
									utilisateurId = utilisateur.identifiant
								}
							})
							if (utilisateurId !== '') {
								const hash = await bcrypt.hash(req.body.motdepasse, 10)
								db.hset('utilisateurs:' + utilisateurId, 'motdepasse', hash)
								res.send(utilisateurId)
							} else {
								res.send('email_non_valide')
							}
						})
					}
				})
			}
		}
	})

	app.post('/api/recuperer-donnees-interaction-admin', function (req, res) {
		const code = parseInt(req.body.code)
		db.exists('interactions:' + code, function (err, resultat) {
			if (err) { res.send('erreur'); return false }
			if (resultat === 1) {
				db.hgetall('interactions:' + code, function (err, donneesInteraction) {
					if (err) { res.send('erreur'); return false }
					res.json(donneesInteraction)
				})
			} else {
				res.send('interaction_inexistante')
			}
		})
	})

	app.post('/api/modifier-donnees-interaction-admin', function (req, res) {
		const code = parseInt(req.body.code)
		const champ = req.body.champ
		const valeur = req.body.valeur
		db.exists('interactions:' + code, function (err, resultat) {
			if (err) { res.send('erreur'); return false }
			if (resultat === 1) {
				db.hset('interactions:' + code, champ, valeur)
				res.send('donnees_modifiees')
			} else {
				res.send('interaction_inexistante')
			}
		})
	})

	app.post('/api/modifier-langue-utilisateur', function (req, res) {
		const identifiant = req.body.identifiant
		if (req.session.identifiant && req.session.identifiant === identifiant) {
			const langue = req.body.langue
			db.hset('utilisateurs:' + identifiant, 'langue', langue)
			req.session.langue = langue
			res.send('langue_modifiee')
		} else {
			res.send('non_connecte')
		}
	})

	app.post('/api/supprimer-compte', function (req, res) {
		const identifiant = req.body.identifiant
		const admin = req.body.admin
		const motdepasseAdmin = process.env.VITE_ADMIN_PASSWORD
		let type = 'utilisateur'
		if ((req.session.identifiant && req.session.identifiant === identifiant) || (admin !== '' && admin === motdepasseAdmin)) {
			if (admin === motdepasseAdmin) {
				type === 'admin'
			}
			db.smembers('interactions-creees:' + identifiant, function (err, interactions) {
				if (err) { res.send('erreur'); return false }
				const donneesInteractions = []
				for (const interaction of interactions) {
					const donneesInteraction = new Promise(async function (resolve) {
						db.del('interactions:' + interaction)
						const chemin = path.join(__dirname, '..', '/static/fichiers/' + interaction)
						if (await fs.pathExists(chemin)) {
							fs.remove(chemin, function () {
								resolve(interaction)
							})
						} else {
							resolve(interaction)
						}
					})
					donneesInteractions.push(donneesInteraction)
				}
				Promise.all(donneesInteractions).then(function () {
					const multi = db.multi()
					multi.del('interactions-creees:' + identifiant)
					multi.del('utilisateurs:' + identifiant)
					multi.exec(function () {
						if (type === 'utilisateur') {
							req.session.identifiant = ''
							req.session.nom = ''
							req.session.email = ''
							req.session.langue = ''
							req.session.role = ''
							req.session.interactions = []
							req.session.destroy()
							res.send('compte_supprime')
						} else {
							db.keys('sessions:*', function (err, sessions) {
								if (sessions !== null) {
									const donneesSessions = []
									sessions.forEach(function (session) {
										const donneesSession = new Promise(function (resolve) {
											db.get('sessions:' + session.substring(9), function (err, donnees) {
												if (err || !donnees || donnees === null) { resolve({}); return false }
												donnees = JSON.parse(donnees)
												if (donnees.hasOwnProperty('identifiant')) {
													resolve({ session: session.substring(9), identifiant: donnees.identifiant })
												} else {
													resolve({})
												}
											})
										})
										donneesSessions.push(donneesSession)
									})
									Promise.all(donneesSessions).then(function (donnees) {
										let sessionId = ''
										donnees.forEach(function (item) {
											if (item.hasOwnProperty('identifiant') && item.identifiant === identifiant) {
												sessionId = item.session
											}
										})
										if (sessionId !== '') {
											db.del('sessions:' + sessionId)
										}
										res.send('compte_supprime')
									})
								}
							})
						}
					})
				})
			})
		} else {
			res.send('non_connecte')
		}
	})

	app.post('/api/rejoindre-interaction', function (req, res) {
		const code = parseInt(req.body.code)
		db.exists('interactions:' + code, function (err, reponse) {
			if (err) { res.send('erreur'); return false }
			if (reponse === 1) {
				if (req.session.identifiant === '' || req.session.identifiant === undefined) {
					const identifiant = 'u' + Math.random().toString(16).slice(3)
					req.session.identifiant = identifiant
					req.session.nom = ''
					req.session.email = ''
					req.session.langue = 'en'
					req.session.role = 'invite'
					req.session.interactions = []
					req.session.cookie.expires = new Date(Date.now() + dureeSession)
				}
				res.json({ code: code, identifiant: req.session.identifiant })
			} else {
				res.send('erreur_code')
			}
		})
	})

	app.post('/api/creer-interaction', function (req, res) {
		const identifiant = req.body.identifiant
		if (req.session.identifiant && req.session.identifiant === identifiant) {
			const titre = req.body.titre
			const type = req.body.type
			const code = Math.floor(1000000 + Math.random() * 9000000)
			const date = dayjs().format()
			db.exists('interactions:' + code, function (err, reponse) {
				if (err) { res.send('erreur'); return false }
				if (reponse === 0) {
					const multi = db.multi()
					multi.hmset('interactions:' + code, 'type', type, 'titre', titre, 'code', code, 'identifiant', identifiant, 'motdepasse', '', 'donnees', JSON.stringify({}), 'reponses', JSON.stringify({}), 'sessions', JSON.stringify({}), 'statut', '', 'session', 1, 'date', date)
					multi.sadd('interactions-creees:' + identifiant, code)
					multi.exec(function () {
						const chemin = path.join(__dirname, '..', '/static/fichiers/' + code)
						fs.mkdirs(chemin, function () {
							res.json({ code: code })
						})
					})
				} else {
					res.send('existe_deja')
				}
			})
		} else {
			res.send('non_connecte')
		}
	})

	app.post('/api/creer-interaction-sans-compte', function (req, res) {
		if (req.session.identifiant === '' || req.session.identifiant === undefined || (req.session.identifiant.length !== 13 && req.session.identifiant.substring(0, 1) !== 'u')) {
			const identifiant = 'u' + Math.random().toString(16).slice(3)
			req.session.identifiant = identifiant
		}
		if (!req.session.hasOwnProperty('interactions')) {
			req.session.interactions = []
		}
		if (!req.session.hasOwnProperty('digidrive')) {
			req.session.digidrive = []
		}
		const titre = req.body.titre
		const type = req.body.type
		const code = Math.floor(1000000 + Math.random() * 9000000)
		const motdepasse = creerMotDePasse()
		const date = dayjs().format()
		db.exists('interactions:' + code, function (err, reponse) {
			if (err) { res.send('erreur'); return false }
			if (reponse === 0) {
				db.hmset('interactions:' + code, 'type', type, 'titre', titre, 'code', code, 'motdepasse', motdepasse, 'donnees', JSON.stringify({}), 'reponses', JSON.stringify({}), 'sessions', JSON.stringify({}), 'statut', '', 'session', 1, 'date', date, function (err) {
					if (err) { res.send('erreur'); return false }
					const chemin = path.join(__dirname, '..', '/static/fichiers/' + code)
					fs.mkdirs(chemin, function () {
						req.session.nom = ''
						req.session.email = ''
						if (req.session.langue === '' || req.session.langue === undefined) {
							req.session.langue = 'en'
						}
						req.session.role = 'auteur'
						req.session.interactions.push({ code: code, motdepasse: motdepasse })
						req.session.cookie.expires = new Date(Date.now() + dureeSession)
						res.json({ code: code })
					})
				})
			} else {
				res.send('existe_deja')
			}
		})
	})

	app.post('/api/modifier-interaction', function (req, res) {
		const identifiant = req.body.identifiant
		if (req.session.identifiant && req.session.identifiant === identifiant) {
			const code = parseInt(req.body.code)
			db.exists('interactions:' + code, function (err, reponse) {
				if (err) { res.send('erreur'); return false }
				if (reponse === 1) {
					db.hgetall('interactions:' + code, function (err, resultat) {
						if (err) { res.send('erreur'); return false }
						const titre = req.body.titre
						const type = resultat.type
						const donnees = req.body.donnees
						const donneesActuelles = JSON.parse(resultat.donnees)
						const fichiersActuels = []
						const fichiers = []
						const corbeille = []
						if (Object.keys(donneesActuelles).length > 0) {
							if (Object.keys(donneesActuelles.support).length > 0) {
								if (donneesActuelles.support.hasOwnProperty('fichier')) {
									fichiersActuels.push(donneesActuelles.support.fichier)
								} else if (donneesActuelles.support.hasOwnProperty('image')) {
									fichiersActuels.push(donneesActuelles.support.image)
								}
							}
							if (type === 'Sondage' || type === 'Questionnaire') {
								if (donneesActuelles.hasOwnProperty('questions')) {
									donneesActuelles.questions.forEach(function (q) {
										q.items.forEach(function (item) {
											if (item.image !== '') {
												fichiersActuels.push(item.image)
											}
										})
									})
								} else {
									donneesActuelles.items.forEach(function (item) {
										if (item.image !== '') {
											fichiersActuels.push(item.image)
										}
									})
								}
							} else if (type === 'Remue-méninges') {
								donneesActuelles.categories.forEach(function (categorie) {
									if (categorie.image !== '') {
										fichiersActuels.push(categorie.image)
									}
								})
							}
							if (Object.keys(donnees.support).length > 0) {
								if (donnees.support.hasOwnProperty('fichier')) {
									fichiers.push(donnees.support.fichier)
								} else if (donnees.support.hasOwnProperty('image')) {
									fichiers.push(donnees.support.image)
								}
							}
							if (type === 'Sondage' || type === 'Questionnaire') {
								if (donnees.hasOwnProperty('questions')) {
									donnees.questions.forEach(function (q) {
										q.items.forEach(function (item) {
											if (item.image !== '') {
												fichiers.push(item.image)
											}
										})
									})
								} else {
									donnees.items.forEach(function (item) {
										if (item.image !== '') {
											fichiers.push(item.image)
										}
									})
								}
							} else if (type === 'Remue-méninges') {
								donnees.categories.forEach(function (categorie) {
									if (categorie.image !== '') {
										fichiers.push(categorie.image)
									}
								})
							}
							fichiersActuels.forEach(function (fichier) {
								if (!fichiers.includes(fichier)) {
									corbeille.push(fichier)
								}
							})
						}
						db.hmset('interactions:' + code, 'titre', titre, 'donnees', JSON.stringify(donnees), function (err) {
							if (err) { res.send('erreur'); return false }
							if (corbeille.length > 0) {
								corbeille.forEach(function (fichier) {
									supprimerFichier(code, fichier)
								})
							}
							res.send('donnees_enregistrees')
						})
					})
				} else {
					res.send('erreur_code')
				}
			})
		} else {
			res.send('non_autorise')
		}
	})

	app.post('/api/modifier-statut-interaction', function (req, res) {
		const identifiant = req.body.identifiant
		if (req.session.identifiant && req.session.identifiant === identifiant) {
			const code = parseInt(req.body.code)
			db.exists('interactions:' + code, function (err, reponse) {
				if (err) { res.send('erreur'); return false }
				if (reponse === 1) {
					const statut = req.body.statut
					if (statut === 'ouvert') {
						db.hgetall('interactions:' + code, function (err, resultat) {
							if (err) { res.send('erreur'); return false }
							const date = dayjs().format()
							const session = resultat.session
							const sessions = JSON.parse(resultat.sessions)
							sessions[session] = {}
							sessions[session].debut = date
							db.hmset('interactions:' + code, 'statut', statut, 'sessions', JSON.stringify(sessions), function (err) {
								if (err) { res.send('erreur'); return false }
								res.send('statut_modifie')
							})
						})
					} else {
						db.hset('interactions:' + code, 'statut', statut, function (err) {
							if (err) { res.send('erreur'); return false }
							res.send('statut_modifie')
						})
					}
				} else {
					res.send('erreur_code')
				}
			})
		} else {
			res.send('non_autorise')
		}
	})

	app.post('/api/modifier-index-question', function (req, res) {
		const identifiant = req.body.identifiant
		if (req.session.identifiant && req.session.identifiant === identifiant) {
			const code = parseInt(req.body.code)
			const indexQuestion = req.body.indexQuestion
			db.exists('interactions:' + code, function (err, reponse) {
				if (err) { res.send('erreur'); return false }
				if (reponse === 1) {
					db.hgetall('interactions:' + code, function (err, resultat) {
						if (err) { res.send('erreur'); return false }
						const donnees = JSON.parse(resultat.donnees)
						donnees.indexQuestion = indexQuestion
						db.hset('interactions:' + code, 'donnees', JSON.stringify(donnees), function (err) {
							if (err) { res.send('erreur'); return false }
							res.send('index_modifie')
						})
					})
				} else {
					res.send('erreur_code')
				}
			})
		} else {
			res.send('non_autorise')
		}
	})

	app.post('/api/fermer-interaction', function (req, res) {
		const identifiant = req.body.identifiant
		if (req.session.identifiant && req.session.identifiant === identifiant) {
			const code = parseInt(req.body.code)
			db.exists('interactions:' + code, function (err, reponse) {
				if (err) { res.send('erreur'); return false }
				if (reponse === 1) {
					db.hgetall('interactions:' + code, function (err, resultat) {
						if (err) { res.send('erreur'); return false }
						const date = dayjs().format()
						let session = resultat.session
						const type = resultat.type
						const donnees = JSON.parse(resultat.donnees)
						const reponses = JSON.parse(resultat.reponses)
						const sessions = JSON.parse(resultat.sessions)
						if (reponses[session] && reponses[session].length > 0 && sessions[session]) {
							sessions[session].fin = date
							sessions[session].donnees = donnees
							if (type === 'Questionnaire') {
								sessions[session].classement = req.body.classement
							}
						} else if (sessions[session]) {
							delete sessions[session]
						}
						session = parseInt(session) + 1
						if (type === 'Questionnaire') {
							donnees.indexQuestion = donnees.copieIndexQuestion
							db.hmset('interactions:' + code, 'statut', 'termine', 'donnees', JSON.stringify(donnees), 'sessions', JSON.stringify(sessions), 'session', session, function (err) {
								if (err) { res.send('erreur'); return false }
								res.json({ session: session, reponses: reponses, sessions: sessions })
							})
						} else {
							db.hmset('interactions:' + code, 'statut', 'termine', 'sessions', JSON.stringify(sessions), 'session', session, function (err) {
								if (err) { res.send('erreur'); return false }
								res.json({ session: session, reponses: reponses, sessions: sessions })
							})
						}
					})
				} else {
					res.send('erreur_code')
				}
			})
		} else {
			res.send('non_autorise')
		}
	})

	app.post('/api/se-connecter-interaction', function (req, res) {
		if (req.session.identifiant === '' || req.session.identifiant === undefined) {
			const identifiant = 'u' + Math.random().toString(16).slice(3)
			req.session.identifiant = identifiant
		}
		if (!req.session.hasOwnProperty('interactions')) {
			req.session.interactions = []
		}
		const code = parseInt(req.body.code)
		const motdepasse = req.body.motdepasse
		db.exists('interactions:' + code, function (err, reponse) {
			if (err) { res.send('erreur'); return false }
			if (reponse === 1) {
				db.hgetall('interactions:' + code, function (err, resultat) {
					if (err) { res.send('erreur'); return false }
					if (motdepasse !== '' && motdepasse === resultat.motdepasse) {
						req.session.nom = ''
						req.session.email = ''
						if (req.session.langue === '' || req.session.langue === undefined) {
							req.session.langue = 'en'
						}
						req.session.role = 'auteur'
						req.session.cookie.expires = new Date(Date.now() + dureeSession)
						req.session.interactions.push({ code: code, motdepasse: motdepasse })
						res.json({ code: code, identifiant: req.session.identifiant, nom: '', role: 'auteur', interactions: req.session.interactions })
					} else {
						res.send('non_autorise')
					}
				})
			} else {
				res.send('erreur_code')
			}
		})
	})

	app.post('/api/recuperer-donnees-interaction', function (req, res) {
		const code = parseInt(req.body.code)
		db.exists('interactions:' + code, function (err, reponse) {
			if (err) { res.send('erreur'); return false }
			if (reponse === 1) {
				db.hgetall('interactions:' + code, function (err, resultat) {
					if (err) { res.send('erreur'); return false }
					const type = resultat.type
					const titre = resultat.titre
					const donnees = JSON.parse(resultat.donnees)
					const reponses = JSON.parse(resultat.reponses)
					const sessions = JSON.parse(resultat.sessions)
					const statut = resultat.statut
					const session = parseInt(resultat.session)
					if (resultat.hasOwnProperty('identifiant')) {
						const identifiant = resultat.identifiant
						res.json({ type: type, titre: titre, identifiant: identifiant, motdepasse: '', donnees: donnees, reponses: reponses, sessions: sessions, statut: statut, session: session })
					} else if (resultat.hasOwnProperty('motdepasse')) {
						const motdepasse = resultat.motdepasse
						res.json({ type: type, titre: titre, identifiant: '', motdepasse: motdepasse, donnees: donnees, reponses: reponses, sessions: sessions, statut: statut, session: session })
					}
				})
			} else {
				res.send('erreur')
			}
		})
	})

	app.post('/api/verifier-acces', function (req, res) {
		const code = parseInt(req.body.code)
		const identifiant = req.body.identifiant
		const motdepasse = req.body.motdepasse
		db.exists('interactions:' + code, function (err, reponse) {
			if (err) { res.send('erreur'); return false }
			if (reponse === 1) {
				db.hgetall('interactions:' + code, function (err, donnees) {
					if (err) { res.send('erreur'); return false }
					if (donnees.hasOwnProperty('motdepasse') && motdepasse !== '' && motdepasse === donnees.motdepasse) {
						req.session.identifiant = identifiant
						req.session.nom = ''
						req.session.email = ''
						if (req.session.langue === '' || req.session.langue === undefined) {
							req.session.langue = 'en'
						}
						req.session.role = 'auteur'
						req.session.cookie.expires = new Date(Date.now() + dureeSession)
						if (!req.session.hasOwnProperty('interactions')) {
							req.session.interactions = []
						}
						if (!req.session.interactions.map(item => item.code).includes(code)) {
							req.session.interactions.push({ code: code, motdepasse: motdepasse })
						}
						if (!req.session.hasOwnProperty('digidrive')) {
							req.session.digidrive = []
						}
						if (!req.session.digidrive.includes(code)) {
							req.session.digidrive.push(code)
						}
						res.json({ message: 'interaction_debloquee', code: code, identifiant: identifiant, nom: '', langue: 'fr', role: 'auteur', interactions: req.session.interactions, digidrive: req.session.digidrive })
					} else if (identifiant === donnees.identifiant && donnees.hasOwnProperty('motdepasse') && donnees.motdepasse === '') {
						db.exists('utilisateurs:' + identifiant, function (err, resultat) {
							if (err) { res.send('erreur'); return false }
							if (resultat === 1) {
								db.hgetall('utilisateurs:' + identifiant, async function (err, utilisateur) {
									if (err) { res.send('erreur'); return false }
									if (motdepasse.trim() !== '' && utilisateur.hasOwnProperty('motdepasse') && utilisateur.motdepasse.trim() !== '' && await bcrypt.compare(motdepasse, utilisateur.motdepasse)) {
										req.session.identifiant = identifiant
										req.session.nom = utilisateur.nom
										req.session.email = ''
										req.session.langue = utilisateur.langue
										req.session.role = 'auteur'
										req.session.cookie.expires = new Date(Date.now() + dureeSession)
										if (!req.session.hasOwnProperty('interactions')) {
											req.session.interactions = []
										}
										if (!req.session.interactions.map(item => item.code).includes(code)) {
											req.session.interactions.push({ code: code, motdepasse: motdepasse })
										}
										if (!req.session.hasOwnProperty('digidrive')) {
											req.session.digidrive = []
										}
										if (!req.session.digidrive.includes(code)) {
											req.session.digidrive.push(code)
										}
										res.json({ message: 'interaction_debloquee', code: code, identifiant: identifiant, nom: utilisateur.nom, langue: utilisateur.langue, role: 'auteur', interactions: req.session.interactions, digidrive: req.session.digidrive })
									} else {
										res.send('erreur')
									}
								})
							} else {
								res.send('erreur')
							}
						})	
					} else {
						res.send('erreur')
					}
				})
			} else {
				res.send('erreur')
			}
		})
	})

	app.post('/api/telecharger-informations-interaction', async function (req, res) {
		const identifiant = req.body.identifiant
		if (req.session.identifiant && req.session.identifiant === identifiant) {
			const code = parseInt(req.body.code)
			const motdepasse = req.body.motdepasse
			const type = req.body.type
			const titre = req.body.titre
			const domaine = req.body.domaine
			const doc = new PDFDocument()
			const fichier = code + '_' + Math.random().toString(36).substring(2, 12) + '.pdf'
			const chemin = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + fichier)
			const dossierExiste = await fs.pathExists(path.join(__dirname, '..', '/static/fichiers/' + code))
			if (dossierExiste) {
				const flux = fs.createWriteStream(chemin)
				doc.pipe(flux)
				doc.fontSize(16)
				if (type === 'Sondage') {
					doc.font('Helvetica-Bold').text(t[req.session.langue].sondage + ' - ' + titre)
				} else if (type === 'Questionnaire') {
					doc.font('Helvetica-Bold').text(t[req.session.langue].questionnaire + ' - ' + titre)
				} else if (type === 'Remue-méninges') {
					doc.font('Helvetica-Bold').text(t[req.session.langue].remueMeninges + ' - ' + titre)
				} else if (type === 'Nuage-de-mots') {
					doc.font('Helvetica-Bold').text(t[req.session.langue].nuageDeMots + ' - ' + titre)
				}
				doc.moveDown()
				doc.fontSize(12)
				doc.font('Helvetica').text(t[req.session.langue].code + ' ' + code)
				doc.moveDown()
				doc.font('Helvetica').text(t[req.session.langue].lien).text(domaine + '/p/' + code, {
					link: domaine + '/p/' + code,
					underline: true
				})
				doc.moveDown()
				doc.font('Helvetica').text(t[req.session.langue].lienAdmin).text(domaine + '/c/' + code, {
					link: domaine + '/c/' + code,
					underline: true
				})
				doc.moveDown()
				doc.font('Helvetica').text(t[req.session.langue].motdepasse + ' ' + motdepasse)
				doc.moveDown()
				doc.end()
				flux.on('finish', function () {
					res.send(fichier)
				})
			} else {
				res.send('erreur')
			}
		} else {
			res.send('non_autorise')
		}
	})

	app.post('/api/supprimer-informations-interaction', function (req, res) {
		const code = parseInt(req.body.code)
		const fichier = req.body.fichier
		supprimerFichier(code, fichier)
		res.send('fichier_supprime')
	})

	app.post('/api/dupliquer-interaction', function (req, res) {
		const identifiant = req.body.identifiant
		if (req.session.identifiant && req.session.identifiant === identifiant) {
			const interaction = parseInt(req.body.code)
			db.exists('interactions:' + interaction, function (err, reponse) {
				if (err) { res.send('erreur'); return false }
				if (reponse === 1) {
					db.hgetall('interactions:' + interaction, function (err, parametres) {
						if (err) { res.send('erreur'); return false }
						const code = Math.floor(1000000 + Math.random() * 9000000)
						const date = dayjs().format()
						db.exists('interactions:' + code, function (err, reponse) {
							if (err) { res.send('erreur'); return false }
							if (reponse === 0) {
								const multi = db.multi()
								multi.hmset('interactions:' + code, 'type', parametres.type, 'titre', t[req.session.langue].copieDe + parametres.titre, 'code', code, 'identifiant', identifiant, 'motdepasse', '', 'donnees', parametres.donnees, 'reponses', JSON.stringify({}), 'sessions', JSON.stringify({}), 'statut', '', 'session', 1, 'date', date)
								multi.sadd('interactions-creees:' + identifiant, code)
								multi.exec(async function () {
									const dossierExiste = await fs.pathExists(path.join(__dirname, '..', '/static/fichiers/' + interaction))
									if (dossierExiste) {
										fs.copy(path.join(__dirname, '..', '/static/fichiers/' + interaction), path.join(__dirname, '..', '/static/fichiers/' + code), function () {
											res.json({ type: parametres.type, titre: t[req.session.langue].copieDe + parametres.titre, code: code, identifiant: identifiant, motdepasse: '', donnees: JSON.parse(parametres.donnees), reponses: {}, sessions: {}, statut: '', session: 1, date: date })
										})
									} else {
										res.json({ type: parametres.type, titre: t[req.session.langue].copieDe + parametres.titre, code: code, identifiant: identifiant, motdepasse: '', donnees: JSON.parse(parametres.donnees), reponses: {}, sessions: {}, statut: '', session: 1, date: date })
									}
								})
							} else {
								res.send('existe_deja')
							}
						})
					})
				} else {
					res.send('erreur_code')
				}
			})
		} else {
			res.send('non_autorise')
		}
	})

	app.post('/api/exporter-interaction', function (req, res) {
		const identifiant = req.body.identifiant
		const admin = req.body.admin
		const motdepasseAdmin = process.env.VITE_ADMIN_PASSWORD
		if ((req.session.identifiant && req.session.identifiant === identifiant) || (admin !== '' && admin === motdepasseAdmin)) {
			const code = parseInt(req.body.code)
			db.exists('interactions:' + code, function (err, reponse) {
				if (err) { res.send('erreur'); return false }
				if (reponse === 1) {
					db.hgetall('interactions:' + code, async function (err, parametres) {
						if (err) { res.send('erreur'); return false }
						const chemin = path.join(__dirname, '..', '/static/temp')
						await fs.mkdirp(path.normalize(chemin + '/' + code))
						await fs.mkdirp(path.normalize(chemin + '/' + code + '/fichiers'))
						await fs.writeFile(path.normalize(chemin + '/' + code + '/donnees.json'), JSON.stringify(parametres, '', 4), 'utf8')
						const donnees = JSON.parse(parametres.donnees)
						if (Object.keys(donnees).length > 0) {
							const fichiers = []
							if (Object.keys(donnees.support).length > 0) {
								if (donnees.support.hasOwnProperty('fichier')) {
									fichiers.push(donnees.support.fichier)
								} else if (donnees.support.hasOwnProperty('image')) {
									fichiers.push(donnees.support.image)
								}
							}
							if (parametres.type === 'Sondage' || parametres.type === 'Questionnaire') {
								if (donnees.hasOwnProperty('questions')) {
									donnees.questions.forEach(function (q) {
										if (Object.keys(q.support).length > 0) {
											if (q.support.hasOwnProperty('fichier')) {
												fichiers.push(q.support.fichier)
											} else if (q.support.hasOwnProperty('image')) {
												fichiers.push(q.support.image)
											}
										}
										q.items.forEach(function (item) {
											if (item.image !== '') {
												fichiers.push(item.image)
											}
										})
									})
								} else {
									donnees.items.forEach(function (item) {
										if (item.image !== '') {
											fichiers.push(item.image)
										}
									})
								}
							} else if (parametres.type === 'Remue-méninges') {
								donnees.categories.forEach(function (categorie) {
									if (categorie.image !== '') {
										fichiers.push(categorie.image)
									}
								})
							}
							for (const fichier of fichiers) {
								if (await fs.pathExists(path.join(__dirname, '..', '/static/fichiers/' + code + '/' + fichier))) {
									await fs.copy(path.join(__dirname, '..', '/static/fichiers/' + code + '/' + fichier), path.normalize(chemin + '/' + code + '/fichiers/' + fichier, { overwrite: true }))
								}
							}
							const archiveId = Math.floor((Math.random() * 100000) + 1)
							const sortie = fs.createWriteStream(path.normalize(chemin + '/' + code + '_' + archiveId + '.zip'))
							const archive = archiver('zip', {
								zlib: { level: 9 }
							})
							sortie.on('finish', function () {
								fs.remove(path.normalize(chemin + '/' + code), function () {
									res.send(code + '_' + archiveId + '.zip')
								})
							})
							archive.pipe(sortie)
							archive.directory(path.normalize(chemin + '/' + code), false)
							archive.finalize()
						} else {
							res.send('erreur_donnees')
						}
					})
				} else {
					res.send('erreur_code')
				}
			})
		} else {
			res.send('non_autorise')
		}
	})

	app.post('/api/importer-interaction', function (req, res) {
		const identifiant = req.session.identifiant
		if (!identifiant) {
			res.send('non_autorise')
		} else {
			televerserArchive(req, res, async function (err) {
				if (err) { res.send('erreur_import'); return false }
				try {
					const source = path.join(__dirname, '..', '/static/temp/' + req.file.filename)
					const cible = path.join(__dirname, '..', '/static/temp/archive-' + Math.floor((Math.random() * 100000) + 1))
					await extract(source, { dir: cible })
					const donnees = await fs.readJson(path.normalize(cible + '/donnees.json'))
					const parametres = JSON.parse(req.body.parametres)
					// Vérification des clés des données
					if (donnees.hasOwnProperty('type') && donnees.hasOwnProperty('titre') && donnees.hasOwnProperty('code') && donnees.hasOwnProperty('motdepasse') && donnees.hasOwnProperty('donnees') && donnees.hasOwnProperty('reponses') && donnees.hasOwnProperty('sessions') && donnees.hasOwnProperty('statut') && donnees.hasOwnProperty('session') && donnees.hasOwnProperty('date')) {
						const code = Math.floor(1000000 + Math.random() * 9000000)
						const date = dayjs().format()
						db.exists('interactions:' + code, function (err, reponse) {
							if (err) { res.send('erreur'); return false }
							if (reponse === 0) {
								const multi = db.multi()
								if (parametres.resultats === true) {
									multi.hmset('interactions:' + code, 'type', donnees.type, 'titre', donnees.titre, 'code', code, 'identifiant', identifiant, 'motdepasse', '', 'donnees', donnees.donnees, 'reponses', donnees.reponses, 'sessions', donnees.sessions, 'statut', '', 'session', donnees.session, 'date', date)
								} else {
									multi.hmset('interactions:' + code, 'type', donnees.type, 'titre', donnees.titre, 'code', code, 'identifiant', identifiant, 'motdepasse', '', 'donnees', donnees.donnees, 'reponses', JSON.stringify({}), 'sessions', JSON.stringify({}), 'statut', '', 'session', 1, 'date', date)
								}
								multi.sadd('interactions-creees:' + identifiant, code)
								multi.exec(function () {
									const chemin = path.join(__dirname, '..', '/static/fichiers/' + code)
									fs.move(path.normalize(cible + '/fichiers'), chemin, function () {
										if (parametres.resultats === true) {
											res.json({ type: donnees.type, titre: donnees.titre, code: code, identifiant: identifiant, motdepasse: '', donnees: JSON.parse(donnees.donnees), reponses: JSON.parse(donnees.reponses), sessions: JSON.parse(donnees.sessions), statut: '', session: donnees.session, date: date })
										} else {
											res.json({ type: donnees.type, titre: donnees.titre, code: code, identifiant: identifiant, motdepasse: '', donnees: JSON.parse(donnees.donnees), reponses: {}, sessions: {}, statut: '', session: 1, date: date })
										}
									})
								})
							} else {
								res.send('existe_deja')
							}
						})
					} else {
						await fs.remove(source)
						await fs.remove(cible)
						res.send('donnees_corrompues')
					}
				} catch (err) {
					await fs.remove(path.join(__dirname, '..', '/static/temp/' + req.file.filename))
					res.send('erreur_import')
				}
			})
		}
	})

	app.post('/api/supprimer-interaction', function (req, res) {
		const code = parseInt(req.body.code)
		const identifiant = req.body.identifiant
		const admin = req.body.admin
		const motdepasseAdmin = process.env.VITE_ADMIN_PASSWORD
		if ((req.session.identifiant && req.session.identifiant === identifiant) || (admin !== '' && admin === motdepasseAdmin)) {
			let suppressionFichiers = true
			if (req.body.hasOwnProperty('suppressionFichiers')) {
				suppressionFichiers = req.body.suppressionFichiers
			}
			db.exists('interactions:' + code, function (err, reponse) {
				if (err) { res.send('erreur'); return false }
				if (reponse === 1) {
					const multi = db.multi()
					multi.del('interactions:' + code)
					multi.srem('interactions-creees:' + identifiant, code)
					multi.exec(async function () {
						if (suppressionFichiers === true) {
							await fs.remove(path.join(__dirname, '..', '/static/fichiers/' + code))
						}
						res.send('interaction_supprimee')
					})
				} else {
					res.send('erreur_code')
				}
			})
		} else {
			res.send('non_autorise')
		}
	})

	app.post('/api/exporter-resultat', async function (req, res) {
		const identifiant = req.body.identifiant
		if (req.session.identifiant && req.session.identifiant === identifiant) {
			const code = parseInt(req.body.code)
			const type = req.body.type
			const titre = req.body.titre
			const donnees = req.body.donnees
			const reponses = req.body.reponses
			const dateDebut = req.body.dateDebut
			const dateFin = req.body.dateFin
			const alphabet = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z']
			const doc = new PDFDocument()
			const chemin = path.join(__dirname, '..', '/static/fichiers/' + code + '/resultats.pdf')
			const flux = fs.createWriteStream(chemin)
			doc.pipe(flux)
			doc.fontSize(16)
			if (type === 'Sondage') {
				doc.font('Helvetica-Bold').text(t[req.session.langue].sondage + ' - ' + titre)
			} else if (type === 'Questionnaire') {
				doc.font('Helvetica-Bold').text(t[req.session.langue].questionnaire + ' - ' + titre)
			} else if (type === 'Remue-méninges') {
				doc.font('Helvetica-Bold').text(t[req.session.langue].remueMeninges + ' - ' + titre)
			} else if (type === 'Nuage-de-mots') {
				doc.font('Helvetica-Bold').text(t[req.session.langue].nuageDeMots + ' - ' + titre)
			}
			doc.fontSize(10)
			doc.moveDown()
			if (type === 'Sondage' && donnees.hasOwnProperty('question')) {
				doc.fontSize(8)
				doc.font('Helvetica').text(formaterDate(dateDebut, t[req.session.langue].demarre, req.session.langue) + ' - ' + formaterDate(dateFin, t[req.session.langue].termine, req.session.langue))
				doc.moveDown()
				doc.moveDown()
				doc.fontSize(12)
				doc.font('Helvetica-Bold').text(t[req.session.langue].question, { underline: true })
				if (donnees.question !== '') {
					doc.moveDown()
					doc.font('Helvetica-Bold').text(donnees.question)
				}
				if (Object.keys(donnees.support).length > 0) {
					doc.moveDown()
					const cheminSupport = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + donnees.support.image)
					if (await fs.pathExists(cheminSupport)) {
						const support = await fs.readFile(cheminSupport)
						if (support && magic.includes(support.toString('hex', 0, 4)) === true) {
							doc.image(support, { fit: [120, 120] })
						} else {
							doc.fontSize(10)
							doc.font('Helvetica').text(t[req.session.langue].image + ' ' + donnees.support.alt)
						}
					} else {
						doc.fontSize(10)
						doc.font('Helvetica').text(t[req.session.langue].image + ' ' + donnees.support.alt)
					}
				}
				doc.moveDown()
				doc.fontSize(12)
				doc.font('Helvetica-Bold').text(t[req.session.langue].reponses + ' (' + reponses.length + ')', { underline: true })
				doc.moveDown()
				let items = donnees.items
				if (donnees.option === 'texte-court') {
					items = []
					reponses.forEach(function (donnees) {
						donnees.reponse.forEach(function (reponse) {
							if (!items.includes(reponse.toString().trim())) {
								items.push(reponse.toString().trim())
							}
						})
					})
				}
				const statistiques = definirStatistiquesSondage(donnees, reponses)
				for (let i = 0; i < items.length; i++) {
					if (donnees.option !== 'texte-court' && items[i].texte !== '') {
						doc.fontSize(10)
						doc.font('Helvetica').text(alphabet[i] + '. ' + items[i].texte + ' (' + statistiques.pourcentages[i] + '% - ' + statistiques.personnes[i] + ')')
						if (items[i].image !== '') {
							const cheminImage = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + items[i].image)
							if (await fs.pathExists(cheminImage)) {
								const image = await fs.readFile(cheminImage)
								if (image && magic.includes(image.toString('hex', 0, 4)) === true) {
									doc.image(image, { fit: [75, 75] })
								}
							}
						}
					} else if (donnees.option !== 'texte-court' && items[i].image !== '') {
						doc.fontSize(10)
						const cheminImage = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + items[i].image)
						if (await fs.pathExists(cheminImage)) {
							const image = await fs.readFile(cheminImage)
							doc.font('Helvetica').text(alphabet[i] + '. (' + statistiques.pourcentages[i] + '% - ' + statistiques.personnes[i] + ')').image(image, { fit: [75, 75] })
						} else {
							doc.font('Helvetica').text(alphabet[i] + '. ' + items[i].alt + ' (' + statistiques.pourcentages[i] + '% - ' + statistiques.personnes[i] + ')')
						}
					} else {
						doc.fontSize(10)
						doc.font('Helvetica').text((i + 1) + '. ' + items[i] + ' (' + statistiques.pourcentages[i] + '% - ' + statistiques.personnes[i] + ')')
					}
					doc.moveDown()
				}
			} else if (type === 'Sondage' && donnees.hasOwnProperty('questions')) {
				const statistiques = definirStatistiquesQuestions(donnees.questions, reponses)
				doc.fontSize(8)
				doc.font('Helvetica').text(formaterDate(dateDebut, t[req.session.langue].demarre, req.session.langue) + ' - ' + formaterDate(dateFin, t[req.session.langue].termine, req.session.langue))
				doc.moveDown()
				if (donnees.options.progression === 'libre') {
					doc.font('Helvetica').text(t[req.session.langue].progression + ' ' + t[req.session.langue].progressionLibre)
				} else {
					doc.font('Helvetica').text(t[req.session.langue].progression + ' ' + t[req.session.langue].progressionAnimateur)
				}
				doc.moveDown()
				doc.moveDown()
				if (donnees.description !== '') {
					doc.fontSize(12)
					doc.font('Helvetica-Bold').text(t[req.session.langue].description, { underline: true })
					doc.fontSize(10)
					doc.moveDown()
					doc.font('Helvetica').text(donnees.description)
				}
				if (donnees.description !== '' && Object.keys(donnees.support).length > 0) {
					doc.fontSize(12)
					doc.moveDown()
				}
				if (Object.keys(donnees.support).length > 0) {
					doc.fontSize(12)
					doc.font('Helvetica-Bold').text(t[req.session.langue].support, { underline: true })
					doc.fontSize(10)
					doc.moveDown()
					if (donnees.support.type === 'image' && donnees.support.fichier !== '') {
						const cheminSupport = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + donnees.support.fichier)
						if (await fs.pathExists(cheminSupport)) {
							const support = await fs.readFile(cheminSupport)
							if (support && magic.includes(support.toString('hex', 0, 4)) === true) {
								doc.image(support, { fit: [120, 120] })
							} else {
								doc.font('Helvetica').text(t[req.session.langue].image + ' ' + donnees.support.alt)
							}
						} else {
							doc.font('Helvetica').text(t[req.session.langue].image + ' ' + donnees.support.alt)
						}
					} else if (donnees.support.type === 'audio') {
						doc.font('Helvetica').text(t[req.session.langue].fichierAudio + ' ' + donnees.support.alt)
					} else if (donnees.support.type === 'video') {
						doc.font('Helvetica').text(t[req.session.langue].video, {
							link: donnees.support.lien,
							underline: true
						})
					}
				}
				if (donnees.description !== '' || Object.keys(donnees.support).length > 0) {
					doc.fontSize(12)
					doc.moveDown()
					doc.moveDown()
				}
				for (let i = 0; i < donnees.questions.length; i++) {
					doc.fontSize(14)
					doc.font('Helvetica-Bold').fillColor('black').text(t[req.session.langue].question + ' ' + (i + 1))
					doc.fontSize(10)
					doc.font('Helvetica').text('-----------------------------------------------')
					doc.fontSize(14)
					doc.moveDown()
					doc.fontSize(12)
					doc.font('Helvetica-Bold').text(t[req.session.langue].question, { underline: true })
					if (donnees.questions[i].question !== '') {
						doc.moveDown()
						doc.font('Helvetica-Bold').text(donnees.questions[i].question)
					}
					if (Object.keys(donnees.questions[i].support).length > 0) {
						doc.moveDown()
						const cheminSupport = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + donnees.questions[i].support.image)
						if (await fs.pathExists(cheminSupport)) {
							const support = await fs.readFile(cheminSupport)
							if (support && magic.includes(support.toString('hex', 0, 4)) === true) {
								doc.image(support, { fit: [120, 120] })
							}
						}
					}
					doc.moveDown()
					doc.moveDown()
					doc.fontSize(12)
					doc.font('Helvetica-Bold').text(t[req.session.langue].reponses + ' (' + definirReponses(reponses, i) + ')', { underline: true })
					doc.moveDown()
					if (donnees.questions[i].option !== 'texte-court') {
						for (let j = 0; j < donnees.questions[i].items.length; j++) {
							if (donnees.questions[i].items[j].texte !== '') {
								doc.fontSize(10)
								doc.font('Helvetica').text(alphabet[j] + '. ' + donnees.questions[i].items[j].texte + ' (' + statistiques[i].pourcentages[j] + '% - ' + statistiques[i].personnes[j] + ')')
								if (donnees.questions[i].items[j].image !== '') {
									const cheminImage = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + donnees.questions[i].items[j].image)
									if (await fs.pathExists(cheminImage)) {
										const image = await fs.readFile(cheminImage)
										if (image && magic.includes(image.toString('hex', 0, 4)) === true) {
											doc.image(image, { fit: [75, 75] })
										}
									}
								}
							} else if (donnees.questions[i].items[j].image !== '') {
								doc.fontSize(10)
								const cheminImage = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + donnees.questions[i].items[j].image)
								if (await fs.pathExists(cheminImage)) {
									const image = await fs.readFile(cheminImage)
									doc.font('Helvetica').text(alphabet[j] + '. (' + statistiques[i].pourcentages[j] + '% - ' + statistiques[i].personnes[j] + ')').image(image, { fit: [75, 75] })
								} else {
									doc.font('Helvetica').text(alphabet[j] + '. ' + donnees.questions[i].items[j].alt + ' (' + statistiques[i].pourcentages[j] + '% - ' + statistiques[i].personnes[j] + ')')
								}
							}
							doc.moveDown()
						}
					} else {
						const itemsTexte = []
						reponses.forEach(function (donnees) {
							donnees.reponse[i].forEach(function (reponse) {
								if (!itemsTexte.includes(reponse.toString().trim())) {
									itemsTexte.push(reponse.toString().trim())
								}
							})
						})
						itemsTexte.forEach(async function (item, index) {
							doc.fontSize(10)
							doc.font('Helvetica').text((index + 1) + '. ' + item + ' (' + statistiques[i].pourcentages[index] + '% - ' + statistiques[i].personnes[index] + ')')
							doc.moveDown()
						})
					}
					doc.moveDown()
					doc.moveDown()
				}
			} else if (type === 'Questionnaire') {
				const statistiques = definirStatistiquesQuestions(donnees.questions, reponses)
				const classement = req.body.classement
				doc.fontSize(8)
				doc.font('Helvetica').text(formaterDate(dateDebut, t[req.session.langue].demarre, req.session.langue) + ' - ' + formaterDate(dateFin, t[req.session.langue].termine, req.session.langue))
				doc.moveDown()
				if (donnees.options.progression === 'libre') {
					doc.font('Helvetica').text(t[req.session.langue].progression + ' ' + t[req.session.langue].progressionLibre)
				} else {
					doc.font('Helvetica').text(t[req.session.langue].progression + ' ' + t[req.session.langue].progressionAnimateur)
				}
				doc.moveDown()
				doc.moveDown()
				if (donnees.description !== '') {
					doc.fontSize(12)
					doc.font('Helvetica-Bold').text(t[req.session.langue].description, { underline: true })
					doc.fontSize(10)
					doc.moveDown()
					doc.font('Helvetica').text(donnees.description)
				}
				if (donnees.description !== '' && Object.keys(donnees.support).length > 0) {
					doc.fontSize(12)
					doc.moveDown()
				}
				if (Object.keys(donnees.support).length > 0) {
					doc.fontSize(12)
					doc.font('Helvetica-Bold').text(t[req.session.langue].support, { underline: true })
					doc.fontSize(10)
					doc.moveDown()
					if (donnees.support.type === 'image') {
						const cheminSupport = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + donnees.support.fichier)
						if (await fs.pathExists(cheminSupport)) {
							const support = await fs.readFile(cheminSupport)
							if (support && magic.includes(support.toString('hex', 0, 4)) === true) {
								doc.image(support, { fit: [120, 120] })
							} else {
								doc.font('Helvetica').text(t[req.session.langue].image + ' ' + donnees.support.alt)
							}
						} else {
							doc.font('Helvetica').text(t[req.session.langue].image + ' ' + donnees.support.alt)
						}
					} else if (donnees.support.type === 'audio') {
						doc.font('Helvetica').text(t[req.session.langue].fichierAudio + ' ' + donnees.support.alt)
					} else if (donnees.support.type === 'video') {
						doc.font('Helvetica').text(t[req.session.langue].video, {
							link: donnees.support.lien,
							underline: true
						})
					}
				}
				if (donnees.description !== '' || Object.keys(donnees.support).length > 0) {
					doc.fontSize(12)
					doc.moveDown()
					doc.moveDown()
				}
				for (let i = 0; i < donnees.questions.length; i++) {
					doc.fontSize(14)
					doc.font('Helvetica-Bold').fillColor('black').text(t[req.session.langue].question + ' ' + (i + 1))
					doc.fontSize(10)
					doc.font('Helvetica').text('-----------------------------------------------')
					doc.fontSize(14)
					doc.moveDown()
					doc.fontSize(12)
					doc.font('Helvetica-Bold').text(t[req.session.langue].question, { underline: true })
					if (donnees.questions[i].question !== '') {
						doc.moveDown()
						doc.font('Helvetica-Bold').text(donnees.questions[i].question)
					}
					if (Object.keys(donnees.questions[i].support).length > 0) {
						doc.moveDown()
						const cheminSupport = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + donnees.questions[i].support.image)
						if (await fs.pathExists(cheminSupport)) {
							const support = await fs.readFile(cheminSupport)
							if (support && magic.includes(support.toString('hex', 0, 4)) === true) {
								doc.image(support, { fit: [120, 120] })
							}
						}
					}
					doc.moveDown()
					doc.moveDown()
					doc.fontSize(12)
					doc.font('Helvetica-Bold').text(t[req.session.langue].reponses + ' (' + definirReponses(reponses, i) + ')', { underline: true })
					doc.moveDown()
					if (donnees.questions[i].option !== 'texte-court') {
						for (let j = 0; j < donnees.questions[i].items.length; j++) {
							if (donnees.questions[i].items[j].texte !== '') {
								doc.fontSize(10)
								if (donnees.questions[i].items[j].reponse === true) {
									doc.font('Helvetica').fillColor('#00a695').text(alphabet[j] + '. ' + donnees.questions[i].items[j].texte + ' (' + statistiques[i].pourcentages[j] + '% - ' + statistiques[i].personnes[j] + ') - ' + t[req.session.langue].bonneReponse)
								} else {
									doc.font('Helvetica').fillColor('grey').text(alphabet[j] + '. ' + donnees.questions[i].items[j].texte + ' (' + statistiques[i].pourcentages[j] + '% - ' + statistiques[i].personnes[j] + ')')
								}
								if (donnees.questions[i].items[j].image !== '') {
									const cheminImage = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + donnees.questions[i].items[j].image)
									if (await fs.pathExists(cheminImage)) {
										const image = await fs.readFile(cheminImage)
										if (image && magic.includes(image.toString('hex', 0, 4)) === true) {
											doc.image(image, { fit: [75, 75] })
										}
									}
								}
							} else if (donnees.questions[i].items[j].image !== '') {
								doc.fontSize(10)
								const cheminImage = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + donnees.questions[i].items[j].image)
								if (await fs.pathExists(cheminImage)) {
									const image = await fs.readFile(cheminImage)
									if (donnees.questions[i].items[j].reponse === true) {
										doc.font('Helvetica').fillColor('#00a695').text(alphabet[j] + '. (' + statistiques[i].pourcentages[j] + '% - ' + statistiques[i].personnes[j] + ') - ' + t[req.session.langue].bonneReponse).image(image, { fit: [75, 75] })
									} else {
										doc.font('Helvetica').fillColor('grey').text(alphabet[j] + '. (' + statistiques[i].pourcentages[j] + '% - ' + statistiques[i].personnes[j] + ')').image(image, { fit: [75, 75] })
									}
								} else if (!await fs.pathExists(cheminImage) && donnees.questions[i].items[j].reponse === true) {
									doc.font('Helvetica').fillColor('#00a695').text(alphabet[j] + '. ' + donnees.questions[i].items[j].alt + ' (' + statistiques[i].pourcentages[j] + '% - ' + statistiques[i].personnes[j] + ') - ' + t[req.session.langue].bonneReponse)
								} else if (!await fs.pathExists(cheminImage) && donnees.questions[i].items[j].reponse === false) {
									doc.font('Helvetica').fillColor('grey').text(alphabet[j] + '. ' + donnees.questions[i].items[j].alt + ' (' + statistiques[i].pourcentages[j] + '% - ' + statistiques[i].personnes[j] + ')')
								}
							}
							doc.moveDown()
						}
					} else {
						const itemsTexte = []
						reponses.forEach(function (donnees) {
							donnees.reponse[i].forEach(function (reponse) {
								if (!itemsTexte.includes(reponse.toString().trim())) {
									itemsTexte.push(reponse.toString().trim())
								}
							})
						})
						const reponsesTexte = donnees.questions[i].reponses.split(',')
						reponsesTexte.forEach(function (item, index) {
							reponsesTexte[index] = item.trim()
						})
						itemsTexte.forEach(async function (item, index) {
							doc.fontSize(10)
							if (reponsesTexte.includes(item) === true) {
								doc.font('Helvetica').fillColor('#00a695').text((index + 1) + '. ' + item + ' (' + statistiques[i].pourcentages[index] + '% - ' + statistiques[i].personnes[index] + ') - ' + t[req.session.langue].bonneReponse)
							} else {
								doc.font('Helvetica').fillColor('grey').text((index + 1) + '. ' + item + ' (' + statistiques[i].pourcentages[index] + '% - ' + statistiques[i].personnes[index] + ')')
							}
							doc.moveDown()
						})
					}
					doc.moveDown()
					doc.moveDown()
				}
				if (classement.length > 0 && donnees.options.nom === 'obligatoire') {
					doc.fontSize(14)
					doc.font('Helvetica-Bold').fillColor('black').text(t[req.session.langue].classement)
					doc.fontSize(10)
					doc.font('Helvetica').text('-----------------------------------------------')
					doc.fontSize(14)
					doc.moveDown()
					doc.fontSize(12)
					classement.forEach(function (utilisateur, indexUtilisateur) {
						doc.font('Helvetica').text((indexUtilisateur + 1) + '. ' + utilisateur.nom + ' (' + utilisateur.score + ' ' + t[req.session.langue].points + ')')
						doc.moveDown()
					})
				}
			} else if (type === 'Remue-méninges') {
				let categories = []
				if (donnees.hasOwnProperty('categories')) {
					categories = donnees.categories.filter(function (categorie) {
						return categorie.texte !== '' || categorie.image !== ''
					})
				}
				const messages = definirMessagesRemueMeninges(categories, reponses)
				doc.fontSize(8)
				doc.font('Helvetica').text(formaterDate(dateDebut, t[req.session.langue].demarre, req.session.langue) + ' - ' + formaterDate(dateFin, t[req.session.langue].termine, req.session.langue))
				doc.moveDown()
				doc.moveDown()
				doc.fontSize(12)
				doc.font('Helvetica-Bold').text(t[req.session.langue].question, { underline: true })
				doc.moveDown()
				doc.font('Helvetica-Bold').text(donnees.question)
				if (Object.keys(donnees.support).length > 0) {
					doc.fontSize(10)
					doc.moveDown()
					doc.moveDown()
					doc.fontSize(12)
					doc.font('Helvetica-Bold').text(t[req.session.langue].support, { underline: true })
					doc.fontSize(10)
					doc.moveDown()
					if (donnees.support.type === 'image' && donnees.support.fichier !== '') {
						const cheminSupport = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + donnees.support.fichier)
						if (await fs.pathExists(cheminSupport)) {
							const support = await fs.readFile(cheminSupport)
							if (support && magic.includes(support.toString('hex', 0, 4)) === true) {
								doc.image(support, { fit: [120, 120] })
								doc.moveDown()
							} else {
								doc.font('Helvetica').text(t[req.session.langue].image + ' ' + donnees.support.alt)
								doc.moveDown()
							}
						} else {
							doc.font('Helvetica').text(t[req.session.langue].image + ' ' + donnees.support.alt)
							doc.moveDown()
						}
					} else if (donnees.support.type === 'audio') {
						doc.font('Helvetica').text(t[req.session.langue].fichierAudio + ' ' + donnees.support.alt)
						doc.moveDown()
					} else if (donnees.support.type === 'video') {
						doc.font('Helvetica').text(t[req.session.langue].video, {
							link: donnees.support.lien,
							underline: true
						})
						doc.moveDown()
					}
				}
				doc.moveDown()
				doc.fontSize(12)
				// Messages visibles
				if (categories.length > 0) {
					let totalMessagesVisibles = 0
					messages.visibles.forEach(function (categorie) {
						totalMessagesVisibles = totalMessagesVisibles + categorie.length
					})
					doc.font('Helvetica-Bold').text(t[req.session.langue].reponses + ' (' + totalMessagesVisibles + ')', { underline: true })
					doc.moveDown()
					for (let i = 0; i < categories.length; i++) {
						if (categories[i].texte !== '') {
							doc.fontSize(10)
							doc.font('Helvetica-Bold').text((i + 1) + '. ' + categories[i].texte + ' (' + messages.visibles[i].length + ')')
							if (categories[i].image !== '') {
								const cheminImage = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + categories[i].image)
								if (await fs.pathExists(cheminImage)) {
									const image = await fs.readFile(cheminImage)
									if (image && magic.includes(image.toString('hex', 0, 4)) === true) {
										doc.image(image, { fit: [40, 40] })
										doc.moveDown()
									}
								}
							}
							messages.visibles[i].forEach(function (message) {
								doc.fontSize(9)
								doc.font('Helvetica').text('• ' + message.reponse.texte)
							})
						} else if (categories[i].image !== '') {
							doc.fontSize(10)
							const cheminImage = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + categories[i].image)
							if (await fs.pathExists(cheminImage)) {
								const image = await fs.readFile(cheminImage)
								if (image) {
									doc.font('Helvetica-Bold').text((i + 1) + '. (' + messages.visibles[i].length + ')').image(image, { fit: [40, 40] })
									doc.moveDown()
								} else {
									doc.font('Helvetica-Bold').text((i + 1) + '. ' + categories[i].alt + ' (' + messages.visibles[i].length + ')')
								}
							} else {
								doc.font('Helvetica-Bold').text((index + 1) + '. ' + categories[i].alt + ' (' + messages.visibles[i].length + ')')
							}
							messages.visibles[i].forEach(function (message) {
								doc.fontSize(9)
								doc.font('Helvetica').text('• ' + message.reponse.texte)
							})
						}
						doc.moveDown()
					}
				} else {
					doc.font('Helvetica-Bold').text(t[req.session.langue].reponses + ' (' + messages.visibles.length + ')', { underline: true })
					doc.moveDown()
					messages.visibles.forEach(function (message) {
						doc.fontSize(9)
						doc.font('Helvetica').text('• ' + message.reponse.texte)
					})
				}
				// Messages supprimés
				if (messages.supprimes.length > 0) {
					doc.moveDown()
					doc.fontSize(12)
					if (categories.length > 0) {
						let totalMessagesSupprimes = 0
						messages.supprimes.forEach(function (categorie) {
							totalMessagesSupprimes = totalMessagesSupprimes + categorie.length
						})
						doc.font('Helvetica-Bold').text(t[req.session.langue].messagesSupprimes + ' (' + totalMessagesSupprimes + ')', { underline: true })
						doc.moveDown()
						for (let i = 0; i < categories.length; i++) {
							if (categories[i].texte !== '') {
								doc.fontSize(10)
								doc.font('Helvetica-Bold').text((i + 1) + '. ' + categories[i].texte + ' (' + messages.supprimes[i].length + ')')
								if (categories[i].image !== '') {
									const cheminImage = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + categories[i].image)
									if (await fs.pathExists(cheminImage)) {
										const image = await fs.readFile(cheminImage)
										if (image && magic.includes(image.toString('hex', 0, 4)) === true) {
											doc.image(image, { fit: [40, 40] })
											doc.moveDown()
										}
									}
								}
								messages.supprimes[i].forEach(function (message) {
									doc.fontSize(9)
									doc.font('Helvetica').text('• ' + message.reponse.texte)
								})
							} else if (categories[i].image !== '') {
								doc.fontSize(10)
								const cheminImage = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + categories[i].image)
								if (await fs.pathExists(cheminImage)) {
									const image = await fs.readFile(cheminImage)
									doc.font('Helvetica-Bold').text((i + 1) + '. (' + messages.supprimes[i].length + ')').image(image, { fit: [40, 40] })
									doc.moveDown()
								} else {
									doc.font('Helvetica-Bold').text((index + 1) + '. ' + categories[i].alt + ' (' + messages.supprimes[i].length + ')')
								}
								messages.supprimes[i].forEach(function (message) {
									doc.fontSize(9)
									doc.font('Helvetica').text('• ' + message.reponse.texte)
								})
							}
							doc.moveDown()
						}
					} else {
						doc.font('Helvetica-Bold').text(t[req.session.langue].messagesSupprimes + ' (' + messages.supprimes.length + ')', { underline: true })
						doc.moveDown()
						messages.supprimes.forEach(function (message) {
							doc.fontSize(9)
							doc.font('Helvetica').text('• ' + message.reponse.texte)
						})
					}
				}
			} else if (type === 'Nuage-de-mots') {
				const mots = definirMotsNuageDeMots(reponses)
				doc.fontSize(8)
				doc.font('Helvetica').text(formaterDate(dateDebut, t[req.session.langue].demarre, req.session.langue) + ' - ' + formaterDate(dateFin, t[req.session.langue].termine, req.session.langue))
				doc.moveDown()
				doc.moveDown()
				doc.fontSize(12)
				doc.font('Helvetica-Bold').text(t[req.session.langue].question, { underline: true })
				doc.moveDown()
				doc.font('Helvetica-Bold').text(donnees.question)
				if (Object.keys(donnees.support).length > 0) {
					doc.fontSize(10)
					doc.moveDown()
					doc.moveDown()
					doc.fontSize(12)
					doc.font('Helvetica-Bold').text(t[req.session.langue].support, { underline: true })
					doc.fontSize(10)
					doc.moveDown()
					if (donnees.support.type === 'image' && donnees.support.fichier !== '') {
						const cheminSupport = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + donnees.support.fichier)
						if (await fs.pathExists(cheminSupport)) {
							const support = await fs.readFile(cheminSupport)
							if (support && magic.includes(support.toString('hex', 0, 4)) === true) {
								doc.image(support, { fit: [120, 120] })
								doc.moveDown()
							} else {
								doc.font('Helvetica').text(t[req.session.langue].image + ' ' + donnees.support.alt)
								doc.moveDown()
							}
						} else {
							doc.font('Helvetica').text(t[req.session.langue].image + ' ' + donnees.support.alt)
							doc.moveDown()
						}
					} else if (donnees.support.type === 'audio') {
						doc.font('Helvetica').text(t[req.session.langue].fichierAudio + ' ' + donnees.support.alt)
						doc.moveDown()
					} else if (donnees.support.type === 'video') {
						doc.font('Helvetica').text(t[req.session.langue].video, {
							link: donnees.support.lien,
							underline: true
						})
						doc.moveDown()
					}
				}
				doc.moveDown()
				doc.fontSize(12)
				doc.font('Helvetica-Bold').text(t[req.session.langue].reponses + ' (' + mots.visibles.length + ')', { underline: true })
				doc.moveDown()
				mots.visibles.forEach(function (mot) {
					doc.fontSize(9)
					doc.font('Helvetica').text('• ' + mot.reponse.texte)
				})
				if (mots.supprimes.length > 0) {
					doc.moveDown()
					doc.fontSize(12)
					doc.font('Helvetica-Bold').text(t[req.session.langue].motsSupprimes + ' (' + mots.supprimes.length + ')', { underline: true })
					doc.moveDown()
					mots.supprimes.forEach(function (mot) {
						doc.fontSize(9)
						doc.font('Helvetica').text('• ' + mot.reponse.texte)
					})
				}
			}
			doc.end()
			flux.on('finish', function () {
				res.send('resultat_exporte')
			})
		} else {
			res.send('non_autorise')
		}
	})

	app.post('/api/supprimer-resultat', function (req, res) {
		const identifiant = req.body.identifiant
		if (req.session.identifiant && req.session.identifiant === identifiant) {
			const code = parseInt(req.body.code)
			const session = parseInt(req.body.session)
			db.exists('interactions:' + code, function (err, reponse) {
				if (err) { res.send('erreur'); return false }
				if (reponse === 1) {
					db.hgetall('interactions:' + code, function (err, donnees) {
						if (err) { res.send('erreur'); return false }
						const reponses = JSON.parse(donnees.reponses)
						const sessions = JSON.parse(donnees.sessions)
						if (reponses[session]) {
							delete reponses[session]
						}
						if (sessions[session]) {
							delete sessions[session]
						}
						db.hmset('interactions:' + code, 'reponses', JSON.stringify(reponses), 'sessions', JSON.stringify(sessions), function (err) {
							if (err) { res.send('erreur'); return false }
							res.json({ reponses: reponses, sessions: sessions })
						})
					})
				} else {
					res.send('erreur_code')
				}
			})
		} else {
			res.send('non_autorise')
		}
	})

	app.post('/api/televerser-image', function (req, res) {
		const identifiant = req.session.identifiant
		if (!identifiant) {
			res.send('non_autorise')
		} else {
			televerser(req, res, function (err) {
				if (err) { res.send('erreur'); return false }
				const fichier = req.file
				if (fichier.hasOwnProperty('filename')) {
					let alt = path.parse(fichier.filename).name
					if (fichier.hasOwnProperty('originalname')) {
						alt = path.parse(fichier.originalname).name
					}
					const code = req.body.code
					const chemin = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + fichier.filename)
					const extension = path.parse(fichier.filename).ext
					if (extension.toLowerCase() === '.jpg' || extension.toLowerCase() === '.jpeg') {
						sharp(chemin).withMetadata().rotate().jpeg().resize(1000, 1000, {
							fit: sharp.fit.inside,
							withoutEnlargement: true
						}).toBuffer((err, buffer) => {
							if (err) { res.send('erreur'); return false }
							fs.writeFile(chemin, buffer, function () {
								res.json({ image: fichier.filename, alt: alt })
							})
						})
					} else {
						sharp(chemin).withMetadata().resize(1000, 1000, {
							fit: sharp.fit.inside,
							withoutEnlargement: true
						}).toBuffer((err, buffer) => {
							if (err) { res.send('erreur'); return false }
							fs.writeFile(chemin, buffer, function () {
								res.json({ image: fichier.filename, alt: alt })
							})
						})
					}
				} else {
					res.send('erreur')
				}
			})
		}
	})

	app.post('/api/dupliquer-images', function (req, res) {
		const code = req.body.code
		const images = req.body.images
		images.forEach(async function (image) {
			if (await fs.pathExists(path.join(__dirname, '..', '/static/fichiers/' + code + '/' + image))) {
				await fs.copy(path.join(__dirname, '..', '/static/fichiers/' + code + '/' + image), path.join(__dirname, '..', '/static/fichiers/' + code + '/dup-' + image))
			}
		})
		res.send('images_dupliquees')
	})

	app.post('/api/televerser-media', function (req, res) {
		const identifiant = req.session.identifiant
		if (!identifiant) {
			res.send('non_autorise')
		} else {
			televerser(req, res, function (err) {
				if (err) { res.send('erreur'); return false }
				const fichier = req.file
				if (fichier.hasOwnProperty('filename') && fichier.hasOwnProperty('originalname')) {
					const info = path.parse(fichier.originalname)
					const alt = info.name
					const extension = info.ext.toLowerCase()
					const code = req.body.code
					const chemin = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + fichier.filename)
					if (extension === '.jpg' || extension === '.jpeg') {
						sharp(chemin).withMetadata().rotate().jpeg().resize(1000, 1000, {
							fit: sharp.fit.inside,
							withoutEnlargement: true
						}).toBuffer((err, buffer) => {
							if (err) { res.send('erreur'); return false }
							fs.writeFile(chemin, buffer, function () {
								res.json({ fichier: fichier.filename, alt: alt, type: 'image' })
							})
						})
					} else if (extension === '.png' || extension === '.gif') {
						sharp(chemin).withMetadata().resize(1000, 1000, {
							fit: sharp.fit.inside,
							withoutEnlargement: true
						}).toBuffer((err, buffer) => {
							if (err) { res.send('erreur'); return false }
							fs.writeFile(chemin, buffer, function () {
								res.json({ fichier: fichier.filename, alt: alt, type: 'image' })
							})
						})
					} else {
						res.json({ fichier: fichier.filename, alt: alt, type: 'audio' })
					}
				} else {
					res.send('erreur')
				}
			})
		}
	})

	app.post('/api/supprimer-fichiers', function (req, res) {
		const code = req.body.code
		const fichiers = req.body.fichiers
		fichiers.forEach(function (fichier) {
			supprimerFichier(code, fichier)
		})
		res.send('fichiers_supprimes')
	})

	app.post('/api/ladigitale', function (req, res) {
		const tokenApi = req.body.token
		const domaine = req.headers.host
		const lien = req.body.lien
		const params = new URLSearchParams()
		params.append('token', tokenApi)
		params.append('domaine', domaine)
		axios.post(lien, params).then(function (reponse) {
			if (reponse.data === 'non_autorise' || reponse.data === 'erreur') {
				res.send('erreur_token')
			} else if (reponse.data === 'token_autorise' && req.body.action && req.body.action === 'creer') {
				const titre = req.body.nom
				const type = req.body.interaction
				const code = Math.floor(1000000 + Math.random() * 9000000)
				const motdepasse = req.body.motdepasse
				const date = dayjs().format()
				db.exists('interactions:' + code, function (err, reponse) {
					if (err) { res.send('erreur'); return false }
					if (reponse === 0) {
						db.hmset('interactions:' + code, 'type', type, 'titre', titre, 'code', code, 'motdepasse', motdepasse, 'donnees', JSON.stringify({}), 'reponses', JSON.stringify({}), 'sessions', JSON.stringify({}), 'statut', '', 'session', 1, 'date', date, function (err) {
							if (err) { res.send('erreur'); return false }
							const chemin = path.join(__dirname, '..', '/static/fichiers/' + code)
							fs.mkdirs(chemin, function () {
								res.send(code.toString())
							})
						})
					} else {
						res.send('erreur')
					}
				})
			} else if (reponse.data === 'token_autorise' && req.body.action && req.body.action === 'modifier-titre') {
				const code = req.body.id
				const titre = req.body.titre
				db.hmset('interactions:' + code, 'titre', titre, function (err) {
					if (err) { res.send('erreur'); return false }
					res.send('titre_modifie')
				})
			} else if (reponse.data === 'token_autorise' && req.body.action && req.body.action === 'ajouter') {
				const identifiant = req.body.identifiant
				const motdepasse = req.body.motdepasse
				const code = parseInt(req.body.id)
				db.exists('interactions:' + code, function (err, reponse) {
					if (err) { res.send('erreur'); return false }
					if (reponse === 1) {
						db.hgetall('interactions:' + code, function (err, donnees) {
							if (err) { res.send('erreur'); return false }
							if (donnees.hasOwnProperty('motdepasse') && motdepasse === donnees.motdepasse) {
								res.json({ titre: donnees.titre, identifiant: identifiant })
							} else if (donnees.hasOwnProperty('motdepasse') && donnees.motdepasse === '') {
								db.exists('utilisateurs:' + donnees.identifiant, function (err, resultat) {
									if (err) { res.send('erreur'); return false }
									if (resultat === 1) {
										db.hgetall('utilisateurs:' + donnees.identifiant, async function (err, utilisateur) {
											if (err) { res.send('erreur'); return false }
											if (motdepasse.trim() !== '' && utilisateur.hasOwnProperty('motdepasse') && utilisateur.motdepasse.trim() !== '' && await bcrypt.compare(motdepasse, utilisateur.motdepasse)) {
												res.json({ titre: donnees.titre, identifiant: donnees.identifiant })
											} else {
												res.send('non_autorise')
											}
										})
									} else {
										res.send('erreur')
									}
								})
							} else {
								res.send('non_autorise')
							}
						})
					} else {
						res.send('contenu_inexistant')
					}
				})
			} else if (reponse.data === 'token_autorise' && req.body.action && req.body.action === 'supprimer') {
				const identifiant = req.body.identifiant
				const motdepasse = req.body.motdepasse
				const code = parseInt(req.body.id)
				db.exists('interactions:' + code, function (err, reponse) {
					if (err) { res.send('erreur'); return false }
					if (reponse === 1) {
						db.hgetall('interactions:' + code, async function (err, donnees) {
							if (err) { res.send('erreur'); return false }
							if (donnees.hasOwnProperty('motdepasse') && motdepasse === donnees.motdepasse) {
								db.del('interactions:' + code)
								await fs.remove(path.join(__dirname, '..', '/static/fichiers/' + code))
								res.send('contenu_supprime')
							} else if (donnees.hasOwnProperty('motdepasse') && donnees.motdepasse === '') {
								db.exists('utilisateurs:' + identifiant, function (err, resultat) {
									if (err) { res.send('erreur'); return false }
									if (resultat === 1) {
										db.hgetall('utilisateurs:' + identifiant, async function (err, utilisateur) {
											if (err) { res.send('erreur'); return false }
											if (motdepasse.trim() !== '' && utilisateur.hasOwnProperty('motdepasse') && utilisateur.motdepasse.trim() !== '' && await bcrypt.compare(motdepasse, utilisateur.motdepasse)) {
												const multi = db.multi()
												multi.del('interactions:' + code)
												multi.srem('interactions-creees:' + identifiant, code)
												multi.exec(async function () {
													await fs.remove(path.join(__dirname, '..', '/static/fichiers/' + code))
													res.send('contenu_supprime')
												})
											} else {
												res.send('non_autorise')
											}
										})
									} else {
										res.send('erreur')
									}
								})
							} else {
								res.send('non_autorise')
							}
						})
					} else {
						res.send('contenu_supprime')
					}
				})
			} else {
				res.send('erreur')
			}
		}).catch(function () {
			res.send('erreur')
		})
	})

	app.use(function (req, res) {
		res.redirect('/')
	})

	const port = process.env.PORT || 3000
	httpServer.listen(port)

	const io = new Server(httpServer, { cookie: false })
	const wrap = middleware => (socket, next) => middleware(socket.request, {}, next)
	io.use(wrap(sessionMiddleware))

	io.on('connection', function (socket) {
		socket.on('connexion', async function (donnees) {
			const code = donnees.code
			const identifiant = donnees.identifiant
			const nom = donnees.nom
			socket.identifiant = identifiant
			socket.nom = nom
			socket.join(code)
			const clients = await io.in(code).fetchSockets()
			let utilisateurs = []
			for (let i = 0; i < clients.length; i++) {
				utilisateurs.push({ identifiant: clients[i].identifiant, nom: clients[i].nom })
			}
			utilisateurs = utilisateurs.filter((valeur, index, self) =>
				index === self.findIndex((t) => (
					t.identifiant === valeur.identifiant && t.nom === valeur.nom
				))
			)
			io.in(code).emit('connexion', utilisateurs)
		})

		socket.on('deconnexion', function (code) {
			socket.leave(code)
			socket.to(code).emit('deconnexion', socket.request.session.identifiant)
		})

		socket.on('interactionouverte', function (donnees) {
			socket.to(donnees.code).emit('interactionouverte', donnees)
		})

		socket.on('interactionenattente', function (code, donnees) {
			socket.to(code).emit('interactionenattente', donnees)
		})

		socket.on('interactionverrouillee', function (code) {
			socket.to(code).emit('interactionverrouillee')
		})

		socket.on('interactiondeverrouillee', function (code) {
			socket.to(code).emit('interactiondeverrouillee')
		})

		socket.on('interactionfermee', function (code) {
			socket.to(code).emit('interactionfermee')
		})

		socket.on('nuageaffiche', function (code) {
			socket.to(code).emit('nuageaffiche')
		})

		socket.on('nuagemasque', function (code) {
			socket.to(code).emit('nuagemasque')
		})

		socket.on('questionsuivante', function (donnees) {
			socket.to(donnees.code).emit('questionsuivante', donnees)
		})

		socket.on('classement', function (code, donnees) {
			socket.to(code).emit('classement', donnees)
		})

		socket.on('modifiernom', function (donnees) {
			socket.to(donnees.code).emit('modifiernom', donnees)
			socket.request.session.nom = donnees.nom
			socket.request.session.save()
		})

		socket.on('reponse', function (reponse) {
			const code = parseInt(reponse.code)
			const session = parseInt(reponse.session)
			db.exists('interactions:' + code, function (err, donnees) {
				if (err) { socket.emit('erreur'); return false }
				if (donnees === 1) {
					db.hgetall('interactions:' + code, function (err, resultat) {
						if (err) { socket.emit('erreur'); return false }
						const type = resultat.type
						let reponses = JSON.parse(resultat.reponses)
						if (!reponses[session]) {
							reponses[session] = []
						}
						if (type === 'Sondage') {
							if (reponses[session].map(function (e) { return e.identifiant }).includes(reponse.donnees.identifiant) === true) {
								reponses[session].forEach(function (item) {
									if (item.identifiant === reponse.donnees.identifiant) {
										item.reponse = reponse.donnees.reponse
										if (item.nom !== reponse.donnees.nom && reponse.donnees.nom !== '') {
											item.nom = reponse.donnees.nom
										}
									}
								})
							} else {
								reponses[session].push(reponse.donnees)
							}
						} else if (type === 'Questionnaire') {
							if (reponses[session].map(function (e) { return e.identifiant }).includes(reponse.donnees.identifiant) === true) {
								reponses[session].forEach(function (item) {
									if (item.identifiant === reponse.donnees.identifiant) {
										item.reponse = reponse.donnees.reponse
										if (reponse.donnees.hasOwnProperty('temps')) {
											item.temps = reponse.donnees.temps
										}
										if (item.nom !== reponse.donnees.nom && reponse.donnees.nom !== '') {
											item.nom = reponse.donnees.nom
										}
									}
								})
							} else {
								reponses[session].push(reponse.donnees)
							}
						} else if (type === 'Remue-méninges' || type === 'Nuage-de-mots') {
							reponses[session].push(reponse.donnees)
						}
						db.hset('interactions:' + code, 'reponses', JSON.stringify(reponses), function (err) {
							if (err) { socket.emit('erreur'); return false }
							socket.to(reponse.code).emit('reponse', reponse)
							socket.emit('reponseenvoyee', reponse)
							socket.emit('reponses', { code: reponse.code, session: reponse.session, reponses: reponses[session] })
							socket.request.session.cookie.expires = new Date(Date.now() + dureeSession)
							socket.request.session.save()
						})
					})
				} else {
					socket.emit('erreurcode')
				}
			})
		})

		socket.on('supprimermessage', function (donnees) {
			const code = parseInt(donnees.code)
			const session = parseInt(donnees.session)
			const id = donnees.id
			db.exists('interactions:' + code, function (err, reponse) {
				if (err) { socket.emit('erreur'); return false }
				if (reponse === 1) {
					db.hgetall('interactions:' + code, function (err, resultat) {
						if (err) { socket.emit('erreur'); return false }
						let reponses = JSON.parse(resultat.reponses)
						if (reponses[session]) {
							reponses[session].forEach(function (item) {
								if (item.reponse.id === id) {
									item.reponse.visible = false
								}
							})
							db.hset('interactions:' + code, 'reponses', JSON.stringify(reponses), function (err) {
								if (err) { socket.emit('erreur'); return false }
								io.in(donnees.code).emit('reponses', { code: donnees.code, session: donnees.session, reponses: reponses[session] })
							})
						}
					})
				} else {
					socket.emit('erreurcode')
				}
			})
		})

		socket.on('reorganisermessages', function (donnees) {
			const code = parseInt(donnees.code)
			const session = parseInt(donnees.session)
			db.exists('interactions:' + code, function (err, reponse) {
				if (err) { socket.emit('erreur'); return false }
				if (reponse === 1) {
					db.hgetall('interactions:' + code, function (err, resultat) {
						if (err) { socket.emit('erreur'); return false }
						let reponses = JSON.parse(resultat.reponses)
						if (reponses[session]) {
							reponses[session] = donnees.reponses
							db.hset('interactions:' + code, 'reponses', JSON.stringify(reponses), function (err) {
								if (err) { socket.emit('erreur'); return false }
								io.in(donnees.code).emit('reponses', { code: donnees.code, session: donnees.session, reponses: reponses[session] })
								socket.request.session.cookie.expires = new Date(Date.now() + dureeSession)
								socket.request.session.save()
							})
						}
					})
				} else {
					socket.emit('erreurcode')
				}
			})
		})

		socket.on('modifiercouleurmot', function (donnees) {
			const code = parseInt(donnees.code)
			const session = parseInt(donnees.session)
			const mot = donnees.mot
			const couleur = donnees.couleur
			db.exists('interactions:' + code, function (err, reponse) {
				if (err) { socket.emit('erreur'); return false }
				if (reponse === 1) {
					db.hgetall('interactions:' + code, function (err, resultat) {
						if (err) { socket.emit('erreur'); return false }
						let reponses = JSON.parse(resultat.reponses)
						if (reponses[session]) {
							reponses[session].forEach(function (item) {
								if (item.reponse.texte === mot) {
									item.reponse.couleur = couleur
								}
							})
							db.hset('interactions:' + code, 'reponses', JSON.stringify(reponses), function (err) {
								if (err) { socket.emit('erreur'); return false }
								socket.to(donnees.code).emit('modifiercouleurmot', { code: donnees.code, session: donnees.session, mot: donnees.mot, couleur: donnees.couleur })
								socket.request.session.cookie.expires = new Date(Date.now() + dureeSession)
								socket.request.session.save()
							})
						}
					})
				} else {
					socket.emit('erreurcode')
				}
			})
		})

		socket.on('supprimermot', function (donnees) {
			const code = parseInt(donnees.code)
			const session = parseInt(donnees.session)
			const mot = donnees.mot
			db.exists('interactions:' + code, function (err, reponse) {
				if (err) { socket.emit('erreur'); return false }
				if (reponse === 1) {
					db.hgetall('interactions:' + code, function (err, resultat) {
						if (err) { socket.emit('erreur'); return false }
						let reponses = JSON.parse(resultat.reponses)
						if (reponses[session]) {
							reponses[session].forEach(function (item) {
								if (item.reponse.texte === mot) {
									item.reponse.visible = false
								}
							})
							db.hset('interactions:' + code, 'reponses', JSON.stringify(reponses), function (err) {
								if (err) { socket.emit('erreur'); return false }
								io.in(donnees.code).emit('reponses', { code: donnees.code, session: donnees.session, reponses: reponses[session] })
							})
						}
					})
				} else {
					socket.emit('erreurcode')
				}
			})
		})

		socket.on('supprimermots', function (donnees) {
			const code = parseInt(donnees.code)
			const session = parseInt(donnees.session)
			const mots = donnees.mots
			db.exists('interactions:' + code, function (err, reponse) {
				if (err) { socket.emit('erreur'); return false }
				if (reponse === 1) {
					db.hgetall('interactions:' + code, function (err, resultat) {
						if (err) { socket.emit('erreur'); return false }
						let reponses = JSON.parse(resultat.reponses)
						if (reponses[session]) {
							reponses[session].forEach(function (item) {
								if (mots.includes(item.reponse.texte) === true) {
									item.reponse.visible = false
								}
							})
							db.hset('interactions:' + code, 'reponses', JSON.stringify(reponses), function (err) {
								if (err) { socket.emit('erreur'); return false }
								socket.to(donnees.code).emit('reponses', { code: donnees.code, session: donnees.session, reponses: reponses[session] })
							})
						}
					})
				} else {
					socket.emit('erreurcode')
				}
			})
		})

		socket.on('modifierlangue', function (langue) {
			socket.request.session.langue = langue
			socket.request.session.save()
		})
	})

	function creerMotDePasse () {
		let motdepasse = ''
		const lettres = 'abcdefghijklmnopqrstuvwxyz'
		for (let i = 0; i < 4; i++) {
			motdepasse += lettres.charAt(Math.floor(Math.random() * 26))
		}
		return motdepasse
	}

	function formaterDate (date, mot, langue) {
		let dateFormattee = ''
		switch (langue) {
			case 'fr':
				dateFormattee = mot + ' le ' + date
				break
			case 'en':
				dateFormattee = mot + ' on ' + date
				break
			case 'es':
				dateFormattee = mot + ' el ' + date
				break
			case 'it':
				dateFormattee = mot + ' il ' + date
				break
		}
		return dateFormattee
	}

	function definirStatistiquesSondage (question, reponses) {
		const personnes = []
		const pourcentages = []
		if (question.option !== 'texte-court') {
			for (let i = 0; i < question.items.length; i++) {
				personnes.push(0)
				pourcentages.push(0)
			}
			question.items.forEach(function (item, index) {
				let total = 0
				let nombreReponses = 0
				reponses.forEach(function (donnees) {
					donnees.reponse.forEach(function (reponse) {
						if (reponse === item.texte || reponse === item.image) {
							nombreReponses++
						}
						total++
					})
				})
				if (nombreReponses > 0) {
					personnes[index] = nombreReponses
					const pourcentage = (nombreReponses / total) * 100
					pourcentages[index] = Math.round(pourcentage)
				}
			})
		} else {
			let items = []
			reponses.forEach(function (donnees) {
				donnees.reponse.forEach(function (reponse) {
					if (!items.includes(reponse.toString().trim())) {
						items.push(reponse.toString().trim())
					}
				})
			})
			for (let i = 0; i < items.length; i++) {
				personnes.push(0)
				pourcentages.push(0)
			}
			items.forEach(function (item, index) {
				let total = 0
				let nombreReponses = 0
				reponses.forEach(function (donnees) {
					donnees.reponse.forEach(function (reponse) {
						if (item === reponse.toString().trim()) {
							nombreReponses++
						}
						total++
					})
				})
				if (nombreReponses > 0) {
					personnes[index] = nombreReponses
					const pourcentage = (nombreReponses / total) * 100
					pourcentages[index] = Math.round(pourcentage)
				}
			})
		}
		return { personnes: personnes, pourcentages: pourcentages }
	}

	function definirMessagesRemueMeninges (categories, reponses) {
		const messagesVisibles = []
		const messagesSupprimes = []
		for (let i = 0; i < categories.length; i++) {
			messagesVisibles.push([])
			messagesSupprimes.push([])
		}
		if (messagesVisibles.length > 0) {
			reponses.forEach(function (item) {
				let index = -1
				categories.forEach(function (categorie, indexCategorie) {
					if (item.reponse.categorie === categorie.texte || item.reponse.categorie === categorie.image) {
						index = indexCategorie
					}
				})
				if (item.reponse.visible && index > -1) {
					messagesVisibles[index].push(item)
				} else if (index > -1) {
					messagesSupprimes[index].push(item)
				}
			})
		} else {
			reponses.forEach(function (item) {
				if (item.reponse.visible) {
					messagesVisibles.push(item)
				} else {
					messagesSupprimes.push(item)
				}
			})
		}
		return { visibles: messagesVisibles, supprimes: messagesSupprimes }
	}

	function definirMotsNuageDeMots (reponses) {
		const messagesVisibles = []
		const messagesSupprimes = []
		reponses.forEach(function (item) {
			if (item.reponse.visible) {
				messagesVisibles.push(item)
			} else {
				messagesSupprimes.push(item)
			}
		})
		return { visibles: messagesVisibles, supprimes: messagesSupprimes }
	}

	function definirStatistiquesQuestions (questions, reponses) {
		const statistiques = []
		questions.forEach(function (question, indexQuestion) {
			const personnes = []
			const pourcentages = []
			if (question.option !== 'texte-court') {
				for (let i = 0; i < question.items.length; i++) {
					personnes.push(0)
					pourcentages.push(0)
				}
				question.items.forEach(function (item, index) {
					let total = 0
					let nombreReponses = 0
					reponses.forEach(function (donnees) {
						donnees.reponse[indexQuestion].forEach(function (reponse) {
							if (reponse === item.texte || reponse === item.image) {
								nombreReponses++
							}
						})
						total++
					})
					if (nombreReponses > 0) {
						personnes[index] = nombreReponses
						const pourcentage = (nombreReponses / total) * 100
						pourcentages[index] = Math.round(pourcentage)
					}
				})
			} else {
				let items = []
				reponses.forEach(function (donnees) {
					donnees.reponse[indexQuestion].forEach(function (reponse) {
						if (!items.includes(reponse.toString().trim())) {
							items.push(reponse.toString().trim())
						}
					})
				})
				for (let i = 0; i < items.length; i++) {
					personnes.push(0)
					pourcentages.push(0)
				}
				items.forEach(function (item, index) {
					let total = 0
					let nombreReponses = 0
					reponses.forEach(function (donnees) {
						donnees.reponse[indexQuestion].forEach(function (reponse) {
							if (item === reponse.toString().trim()) {
								nombreReponses++
							}
							total++
						})
					})
					if (nombreReponses > 0) {
						personnes[index] = nombreReponses
						const pourcentage = (nombreReponses / total) * 100
						pourcentages[index] = Math.round(pourcentage)
					}
				})
			}
			statistiques.push({ personnes: personnes, pourcentages: pourcentages })
		})
		return statistiques
	}

	function definirReponses (reponses, indexQuestion) {
		let total = 0
		reponses.forEach(function (item) {
			if (item.hasOwnProperty('reponse') && item.reponse[indexQuestion].length > 0) {
				total++
			}
		})
		return total
	}

	function genererMotDePasse (longueur) {
		function rand (max) {
			return Math.floor(Math.random() * max)
		}
		function verifierMotDePasse (motdepasse, regex, caracteres) {
			if (!regex.test(motdepasse)) {
				const nouveauCaractere = caracteres.charAt(rand(caracteres.length))
				const position = rand(motdepasse.length + 1)
				motdepasse = motdepasse.slice(0, position) + nouveauCaractere + motdepasse.slice(position)
			}
			return motdepasse
		}
		let caracteres = '123456789abcdefghijklmnopqrstuvwxyz'
		const caracteresSpeciaux = '!#$@*'
		const specialRegex = /[!#\$@*]/
		const majuscules = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
		const majusculesRegex = /[A-Z]/

		caracteres = caracteres.split('')
		let motdepasse = ''
		let index

		while (motdepasse.length < longueur) {
			index = rand(caracteres.length)
			motdepasse += caracteres[index]
			caracteres.splice(index, 1)
		}
		motdepasse = verifierMotDePasse(motdepasse, specialRegex, caracteresSpeciaux)
		motdepasse = verifierMotDePasse(motdepasse, majusculesRegex, majuscules)
		return motdepasse  
	}

	function verifierEmail (email) {
		const regexExp = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/gi
		return regexExp.test(email)
	}

	const televerser = multer({
		storage: multer.diskStorage({
			destination: function (req, fichier, callback) {
				const code = req.body.code
				const chemin = path.join(__dirname, '..', '/static/fichiers/' + code + '/')
				callback(null, chemin)
			},
			filename: function (req, fichier, callback) {
				const info = path.parse(fichier.originalname)
				const extension = info.ext.toLowerCase()
				let nom = v.latinise(info.name.toLowerCase())
				nom = nom.replace(/\ /gi, '-')
				nom = nom.replace(/[^0-9a-z_\-]/gi, '')
				if (nom.length > 100) {
					nom = nom.substring(0, 100)
				}
				nom = nom + '_' + Math.random().toString(36).substring(2) + extension
				callback(null, nom)
			}
		})
	}).single('fichier')

	const televerserArchive = multer({
		storage: multer.diskStorage({
			destination: function (req, fichier, callback) {
				const chemin = path.join(__dirname, '..', '/static/temp/')
				callback(null, chemin)
			},
			filename: function (req, fichier, callback) {
				const info = path.parse(fichier.originalname)
				const extension = info.ext.toLowerCase()
				let nom = v.latinise(info.name.toLowerCase())
				nom = nom.replace(/\ /gi, '-')
				nom = nom.replace(/[^0-9a-z_\-]/gi, '')
				if (nom.length > 100) {
					nom = nom.substring(0, 100)
				}
				nom = nom + '_' + Math.random().toString(36).substring(2) + extension
				callback(null, nom)
			}
		})
	}).single('fichier')

	function recupererDonnees (identifiant) {
		const donneesUtilisateur = new Promise(function (resolve) {
			const filtre = 'date-desc'
			db.exists('utilisateurs:' + identifiant, function (err, reponse) {
				if (err) { resolve(filtre); return false }
				if (reponse === 1) {
					db.hgetall('utilisateurs:' + identifiant, function (err, donnees) {
						if (donnees.hasOwnProperty('filtre')) {
							resolve(donnees.filtre)
						} else {
							resolve(filtre)
						}
					})
				} else {
					resolve(filtre)
				}
			})
		})
		const donneesInteractionsCreees = new Promise(function (resolveMain) {
			db.smembers('interactions-creees:' + identifiant, function (err, interactions) {
				const donneeInteractions = []
				if (err) { resolveMain(donneeInteractions); return false }
				for (const interaction of interactions) {
					const donneeInteraction = new Promise(function (resolve) {
						db.hgetall('interactions:' + interaction, function (err, donnees) {
							if (err) { resolve({}); return false }
							resolve(donnees)
						})
					})
					donneeInteractions.push(donneeInteraction)
				}
				Promise.all(donneeInteractions).then(function (resultat) {
					resolveMain(resultat)
				})
			})
		})
		return Promise.all([donneesInteractionsCreees, donneesUtilisateur])
	}

	async function supprimerFichier (code, fichier) {
		const chemin = path.join(__dirname, '..', '/static/fichiers/' + code + '/' + fichier)
		if (await fs.pathExists(chemin)) {
			await fs.remove(chemin)
		}
	}
}
